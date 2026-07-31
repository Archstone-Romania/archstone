import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, isKnown, openApiAdapter, skipsOperation, valueOrUndefined, type DecisionRecord, type DraftInputField, type ReasonCode, type SourceInput } from "@archstone/init";

// `requestBody` — the construct the oracle could not test.
//
// THE DEFECT. `requestBody` appeared nowhere in the adapter. `collectParameters` handled
// `parameters:` only, so an operation whose input lives in a JSON body emitted a capability with
// no `input:` block at all — and nothing said so. The report listed `contract-not-recorded` and
// `semantic-type-degraded` and was silent about the entire request. An agent would be handed a
// search tool with no parameters, POST an empty body, and get a 400.
//
// WHY IT SURVIVED EVERYTHING. `catalog.yaml` — the shape the real oracle has — is six GETs.
// There is no request body anywhere in it, so no test, no review round and no empirical repro
// could ever have exercised the path. The shape an oracle lacks is the shape it cannot test,
// which is the general lesson and the reason for `document-coverage.test.ts`.
//
// TWO HALVES, IN THIS ORDER. The refusal is the safety property and it landed first, on its own:
// §6 step 5's DoD says every unsupported construct produces a named reason code and ZERO emitted
// files for that operation. Support then CARVES CASES OUT of that blanket — `application/json`
// with named scalar properties — and everything not carved out keeps refusing. Reading the two
// `describe` blocks below in order is reading that history.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function load(primary: string): SourceInput {
  const input: SourceInput = { origin: primary, document: read(primary), documents: {} };
  for (let round = 0; round < 8; round += 1) {
    const wanted = openApiAdapter.references!(input).filter((key) => input.documents![key] === undefined);
    if (wanted.length === 0) return input;
    for (const key of wanted) input.documents![key] = read(key);
  }
  throw new Error("reference closure did not converge");
}

const orders = openApiAdapter.adapt(load("orders.yaml"));

function operation(key: string) {
  const found = orders.operations.find((o) => o.key === key);
  expect(found, `no candidate keyed '${key}'`).toBeDefined();
  return found!;
}

/** The codes on a candidate that promise "no files at all" (D-7). */
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

function names(key: string): string[] {
  return operation(key).input.map((f) => f.name);
}

const decisionsFor = (operationKey: string, capabilityId: string): DecisionRecord => ({
  version: "0",
  company: { id: "acme", name: "Acme Orders" },
  provider: "acme-api",
  decisions: [{ operation: operationKey, keep: true, capabilityId, effect: "read" }],
});

describe("body input reaches the capability (the defect, closed)", () => {
  const SEARCH = "POST /api/v2/orders/search";

  it("the founder's minimal repro: a POST whose only input is a required body property", () => {
    // The whole bug in one assertion. `destination` is declared required by the source and was
    // simply gone; `budget` is the optional sibling that was gone with it.
    expect(names(SEARCH)).toEqual(["destination", "budget"]);
    expect(input(SEARCH, "destination").in).toBe("body");
    expect(valueOrUndefined(input(SEARCH, "destination").required)).toBe(true);
    expect(valueOrUndefined(input(SEARCH, "budget").required)).toBe(false);
  });

  it("uses the SAME semantic-type classifier as parameters, D-4's `*Id` rule included", () => {
    // Not a second classifier: `partId` in a BODY becomes `identifier` for exactly the reason it
    // would as a path parameter. Two rules is how the two sides drift.
    expect(valueOrUndefined(input("POST /api/v2/orders", "partId").type)).toBe("identifier");
    expect(valueOrUndefined(input("POST /api/v2/orders", "quantity").type)).toBe("quantity");
    expect(valueOrUndefined(input("POST /api/v2/orders/{orderId}/notes", "visibility").type)).toBe("enum");
    expect(input("POST /api/v2/orders/{orderId}/notes", "visibility").values).toEqual(["internal", "customer"]);
  });

  it("uses the SAME required rule as parameters — D-12, positive evidence of non-nullability", () => {
    // `pinnedUntil` is in the body schema's `required[]` AND is `type: [string, 'null']`. There
    // is no positive evidence the agent must supply a value, and CDL cannot say "required, but
    // null is a value", so it lowers to optional. Getting this backwards advertises a mandatory
    // parameter the backend is happy to receive as null.
    const pinned = input("POST /api/v2/orders/{orderId}/notes", "pinnedUntil");
    expect(valueOrUndefined(pinned.required)).toBe(false);
    expect(valueOrUndefined(input("POST /api/v2/orders/{orderId}/notes", "body").required)).toBe(true);
  });

  it("...and the rule bites identically on a PARAMETER, its other caller", () => {
    // `classifyInputRequired` is shared, so testing it through body properties alone exercised
    // one of its two callers. `asOf` is a query parameter declared `required: true` with
    // `type: [string, 'null']` — same evidence, same verdict. A path parameter stays required
    // regardless: `interpolatePath` fails the call without one, so no evidence about
    // nullability could make it optional.
    const get = "GET /api/v2/orders/{orderId}";
    expect(valueOrUndefined(input(get, "asOf").required)).toBe(false);
    expect(input(get, "asOf").in).toBe("query");
    expect(valueOrUndefined(input(get, "orderId").required)).toBe(true);
  });

  it("resolves a `$ref`'d requestBody — `components/requestBodies` was unreachable before", () => {
    expect(names("POST /api/v2/orders")).toEqual(["partId", "quantity", "note"]);
  });

  it("composition inside a body goes through the existing D-10 `allOf` merge", () => {
    // Not a second, weaker merge for bodies. `OrderCore`'s three properties AND the inline
    // member's `draftName` both survive — an implementation that read `allOf` as "the schema is
    // its members" would lose one side or the other (D-10.1).
    expect(names("POST /api/v2/orders/drafts")).toEqual(["partId", "quantity", "note", "draftName"]);
    expect(valueOrUndefined(input("POST /api/v2/orders/drafts", "draftName").required)).toBe(true);
  });

  it("path parameters and body properties coexist without either displacing the other", () => {
    const notes = "POST /api/v2/orders/{orderId}/notes";
    expect(input(notes, "orderId").in).toBe("path");
    expect(input(notes, "body").in).toBe("body");
  });

  it("seeds `example` from the body schema, for the gate only (D-13 unchanged)", () => {
    // A spec example pre-fills the gate and renders a legibility comment. It is never probe
    // input: only `DecisionRecord.sampleInput` reaches the wire, because a probe is a live call
    // to a production backend carrying a value the human did not choose.
    const example = input("POST /api/v2/orders/search", "destination").example;
    expect(isKnown(example) && example.value).toBe("Cluj-Napoca");
  });

  it("emits a manifest that compiles, with the body fields as capability input", () => {
    const result = emit(orders, decisionsFor("POST /api/v2/orders/search", "orders.search"));
    const capability = result.files.get("orders.search.capability.yaml")!;
    expect(capability).toMatch(/^\s+destination:$/m);
    expect(capability).toMatch(/^\s+budget:$/m);

    const binding = result.files.get("bindings/orders.search.binding.yaml")!;
    expect(binding).toMatch(/method: POST/);
    expect(binding).toMatch(/path: \/api\/v2\/orders\/search/);
    // NO `rest.body` and NO `rest.query`. `invokeRest` serializes the capability input as the
    // JSON body for any method that is not GET/HEAD, keyed by the CDL field name — which is
    // exactly what the hand-written `tourism.search` binding relies on. Emitting a body template
    // here would be inventing a second, weaker mechanism beside the shipped one.
    expect(binding).not.toMatch(/^\s+body:/m);
    expect(binding).not.toMatch(/^\s+query:/m);
  });
});

describe("what support does NOT cover keeps refusing (§6 step 5 DoD)", () => {
  // Scoped the way the rest of this adapter is scoped. Each of these would otherwise emit a
  // capability that compiles, serves, advertises itself to an agent, and then sends the wrong
  // request — which is worse than not emitting it.
  const REFUSED: ReadonlyArray<readonly [string, ReasonCode, RegExp]> = [
    // §4's existing XML/multipart exclusion, read from the request side.
    ["POST /api/v2/orders/attachments", "unsupported-media-type", /multipart\/form-data/],
    // No named fields, so nothing that could become a capability input.
    ["POST /api/v2/orders/bulk", "unsupported-parameter-location", /schema is a array/],
    // One CDL input field cannot be two wire values, and there is no body counterpart to
    // `rest.query` that could separate them.
    ["POST /api/v2/orders/{orderId}/transfer", "unsupported-parameter-location", /already a path or query parameter/],
    // `invokeRest` appends a query string only when there is no body — found by the coverage
    // audit, not by the bug report, and it predates this change.
    ["POST /api/v2/orders/quote", "unsupported-parameter-location", /sent inside the JSON body instead of on the URL/],
    // Legal to declare, unsendable: a GET never gets a body.
    ["GET /api/v2/orders/legacy-search", "unsupported-parameter-location", /never sends/],
  ];

  it.each(REFUSED)("%s refuses with %s", (key, code, detail) => {
    expect(refusals(key)).toContain(code);
    expect(detailOf(key)).toMatch(detail);
  });

  it.each(REFUSED)("%s emits ZERO files — the part that is a promise, not an annotation", (key) => {
    // `skipsOperation: true` is a claim about the file system, asserted through the real emitter
    // rather than by reading the note. The two are not the same claim, and that distinction is
    // what surfaced the previous round's escaped defect.
    const result = emit(orders, decisionsFor(key, "orders.thing"));
    expect(result.files.size).toBe(0);
    expect(result.capabilities).toEqual([]);
  });

  it("adds no new reason code — R-6's enum is the scope boundary", () => {
    // Every refusal above reuses a member that already existed. What changed is
    // `unsupported-parameter-location`'s SUMMARY, widened to stay true at all its call sites —
    // the same maintenance `nested-object-not-mapped` already needed, and net zero on the enum.
    const used = new Set(orders.operations.flatMap((o) => o.notes.map((n) => n.code)));
    for (const code of used) {
      expect(
        ["unsupported-parameter-location", "unsupported-media-type", "unsupported-ref", "unsupported-composition", "composition-conflict", "semantic-type-degraded", "failures-not-emitted", "identity-ref-not-inferred", "pagination-not-modeled"],
        `unexpected reason code '${code}' — adding one is a scope decision`,
      ).toContain(code);
    }
  });

  it("the no-body negative control is untouched", () => {
    // The shape that was never broken must not start paying for the shape that was.
    expect(refusals("GET /api/v2/orders/{orderId}")).toEqual([]);
    const result = emit(orders, decisionsFor("GET /api/v2/orders/{orderId}", "orders.get"));
    expect(result.files.has("capabilities.yaml")).toBe(true);
    expect(result.capabilities).toHaveLength(1);
  });
});
