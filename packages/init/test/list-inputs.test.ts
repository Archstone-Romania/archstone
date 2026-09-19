import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, isKnown, openApiAdapter, skipsOperation, valueOrUndefined, type DecisionRecord, type DraftInputField, type ReasonCode, type SourceInput } from "@archstone/init";

// Issue #63 — list-valued query parameters (Goal 1), array-of-scalars body properties
// (Goal 3), and their still-refused boundaries (path-location lists, non-scalar items,
// non-`form` styles). Query-alongside-body (Goal 2) is covered in `request-body.test.ts`,
// beside the refusal it replaces.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function load(primary: string): SourceInput {
  return { origin: primary, document: read(primary), documents: {} };
}

const lists = openApiAdapter.adapt(load("lists.yaml"));

function operation(key: string) {
  const found = lists.operations.find((o) => o.key === key);
  expect(found, `no candidate keyed '${key}'`).toBeDefined();
  return found!;
}

function refusals(key: string): ReasonCode[] {
  return operation(key).notes.map((n) => n.code).filter(skipsOperation);
}

function detailOf(key: string): string {
  return operation(key).notes.filter((n) => skipsOperation(n.code)).map((n) => n.detail ?? "").join(" ");
}

function input(key: string, name: string): DraftInputField {
  const found = operation(key).input.find((f) => f.name === name);
  expect(found, `no input '${name}' on ${key}`).toBeDefined();
  return found!;
}

const decisionsFor = (operationKey: string, capabilityId: string, resourceName?: string): DecisionRecord => ({
  version: "0",
  company: { id: "acme", name: "Acme Parts" },
  provider: "acme-api",
  decisions: [{ operation: operationKey, keep: true, capabilityId, effect: "read", ...(resourceName ? { resourceName } : {}) }],
});

describe("Goal 1 — list-valued query parameters", () => {
  const EXPLODED = "GET /api/v2/items";

  it("is not refused, and the field carries `list: true`", () => {
    expect(refusals(EXPLODED)).toEqual([]);
    const field = input(EXPLODED, "tags");
    expect(field.in).toBe("query");
    expect(field.list).toBe(true);
    expect(field.explode).toBe(true);
    expect(valueOrUndefined(field.type)).toBe("string");
  });

  it("preserves an explicit `explode: false` to the Draft Model", () => {
    const field = input("GET /api/v2/items-joined", "tags");
    expect(field.list).toBe(true);
    expect(field.explode).toBe(false);
  });

  it("defaults to `explode: true` when the source declares no style/explode (EC-4)", () => {
    const field = input("GET /api/v2/items-default-style", "ids");
    expect(field.list).toBe(true);
    expect(field.explode).toBe(true);
  });

  it("D-12 applies unchanged: a list carries no nullability evidence, so `required: true` downgrades to optional here — the same rule an unknown-nullability scalar gets", () => {
    const field = input(EXPLODED, "tags");
    expect(valueOrUndefined(field.required)).toBe(false);
  });

  it("emits a binding that records `explode: false` for the comma-joined field", () => {
    const result = emit(lists, decisionsFor("GET /api/v2/items-joined", "items.search-joined", "Item"));
    const binding = result.files.get("bindings/items.search-joined.binding.yaml")!;
    expect(binding).toMatch(/^\s+tags:$/m);
    expect(binding).toMatch(/^\s+explode: false$/m);
  });

  it("emits a capability using CDL's `list:` field form, not `type:`", () => {
    const result = emit(lists, decisionsFor(EXPLODED, "items.search", "Item"));
    const capability = result.files.get("items.search.capability.yaml")!;
    expect(capability).toMatch(/^\s+tags:$/m);
    expect(capability).toMatch(/^\s+list: string$/m);
    expect(capability).not.toMatch(/^\s+type: string$/m);
  });
});

describe("Goal 1 boundaries — still refused", () => {
  const REFUSED: ReadonlyArray<readonly [string, ReasonCode, RegExp]> = [
    // BR-2: list items that are themselves non-scalar.
    ["GET /api/v2/items-object-filter", "unsupported-parameter-location", /items are a object/],
    // #64/BR-6: a REQUIRED `deepObject`-style parameter still refuses — omitting it would send a
    // request missing a value the backend's own contract demands.
    ["GET /api/v2/items-deep-object-required", "unsupported-parameter-location", /style 'deepObject'/],
    // EC-5 / founder ruling: query-location lists only.
    ["GET /api/v2/items/{ids}", "unsupported-parameter-location", /in: path` parameter/],
  ];

  it.each(REFUSED)("%s refuses with %s", (key, code, detail) => {
    expect(refusals(key)).toContain(code);
    expect(detailOf(key)).toMatch(detail);
  });

  it.each(REFUSED)("%s emits ZERO files (D-7)", (key) => {
    const result = emit(lists, decisionsFor(key, "items.thing"));
    expect(result.files.size).toBe(0);
  });
});

// #64: an OPTIONAL non-form-style (`deepObject`) query parameter used to refuse the whole
// operation (EC-3). It is now omitted instead — the surviving sibling parameter keeps the
// candidate alive, and the omission is named with the new reason code.
describe("#64 — an optional deepObject-style query parameter is omitted, not refused", () => {
  const KEY = "GET /api/v2/items-deep-object";

  it("is not refused, and `filters` is absent from the candidate's input fields", () => {
    expect(refusals(KEY)).toEqual([]);
    expect(operation(KEY).input.find((f) => f.name === "filters")).toBeUndefined();
    expect(operation(KEY).input.find((f) => f.name === "q")).toBeDefined();
  });

  it("carries an `input-property-omitted` note naming `filters`", () => {
    const omissionNotes = operation(KEY).notes.filter((n) => n.code === "input-property-omitted");
    expect(omissionNotes).toHaveLength(1);
    expect(omissionNotes[0]!.target).toMatch(/#filters$/);
    expect(omissionNotes[0]!.detail).toMatch(/style 'deepObject'/);
  });

  it("emits a capability file (the candidate is not skipped)", () => {
    const result = emit(lists, decisionsFor(KEY, "items.search-deep-object", "Item"));
    expect(result.files.get("items.search-deep-object.capability.yaml")).toBeDefined();
  });
});

describe("Goal 3 — array-of-scalars request-body property", () => {
  const BULK = "POST /api/v2/items/bulk-tag";

  it("is not refused, and both array properties carry `list: true`", () => {
    expect(refusals(BULK)).toEqual([]);
    const itemIds = input(BULK, "itemIds");
    expect(itemIds.in).toBe("body");
    expect(itemIds.list).toBe(true);
    expect(valueOrUndefined(itemIds.type)).toBe("string");
    const tags = input(BULK, "tags");
    expect(tags.list).toBe(true);
    expect(valueOrUndefined(tags.type)).toBe("string");
  });

  it("emits a capability using `list:`, and NO `rest.query` block (body-only operation)", () => {
    // `bulk-tag`'s response is an inline scalar-only object with no `$ref` component name, so
    // D-9 step 3 asks for one at the gate — orthogonal to this test's point.
    const result = emit(lists, decisionsFor(BULK, "items.bulk-tag", "BulkTagResult"));
    const capability = result.files.get("items.bulk-tag.capability.yaml")!;
    expect(capability).toMatch(/^\s+tags:$/m);
    expect(capability).toMatch(/^\s+list: string$/m);
    const binding = result.files.get("bindings/items.bulk-tag.binding.yaml")!;
    expect(binding).not.toMatch(/^\s+query:/m);
  });

  it("an array-of-objects body property is still refused (BR-9)", () => {
    const key = "POST /api/v2/items/bulk-link";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(detailOf(key)).toMatch(/is an array of object/);
    const result = emit(lists, decisionsFor(key, "items.thing"));
    expect(result.files.size).toBe(0);
  });
});

describe("no new reason code — R-6's enum is the scope boundary", () => {
  it("every note raised by this document reuses a member that already existed", () => {
    const used = new Set(lists.operations.flatMap((o) => o.notes.map((n) => n.code)));
    for (const code of used) {
      expect(
        ["unsupported-parameter-location", "unsupported-media-type", "unsupported-ref", "unsupported-composition", "composition-conflict", "semantic-type-degraded", "failures-not-emitted", "identity-ref-not-inferred", "pagination-not-modeled", "input-property-omitted"],
        `unexpected reason code '${code}' — adding one is a scope decision`,
      ).toContain(code);
    }
  });
});

// Keep the founder's ruling visible in an assertion, not just in a comment: `isKnown` on a
// list field's `required` fact behaves exactly like a scalar's.
describe("required list with an empty value (founder ruling)", () => {
  it("the field's `required` fact means presence, not non-emptiness — no field-level distinction exists", () => {
    const field = input("GET /api/v2/items", "tags");
    expect(isKnown(field.required) && field.required.value).toBe(false);
    // The "[] is allowed, and omits the query param" behaviour is a WIRE rule, exercised
    // end-to-end in providers/rest's own test suite (buildQuery), not here.
  });
});
