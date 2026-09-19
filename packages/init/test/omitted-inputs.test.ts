import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, openApiAdapter, skipsOperation, type DecisionRecord, type ReasonCode, type SourceInput } from "@archstone/init";

// Issue #64 — an unsupported OPTIONAL request-body property or query parameter (a nested
// object, an array of non-scalars, an object-valued query parameter) is now OMITTED from the
// candidate's input fields instead of refusing the whole operation. A REQUIRED occurrence — per
// the schema's own raw `required[]`, never the D-12-lowered value, and independent of the
// enclosing body's own optionality — still refuses exactly as before (D-7). Omitting every
// input on an operation is itself refused (the floor, BR-9).

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function load(primary: string): SourceInput {
  return { origin: primary, document: read(primary), documents: {} };
}

const crate = openApiAdapter.adapt(load("omitted-inputs.yaml"));

function operation(key: string) {
  const found = crate.operations.find((o) => o.key === key);
  expect(found, `no candidate keyed '${key}'`).toBeDefined();
  return found!;
}

function refusals(key: string): ReasonCode[] {
  return operation(key).notes.map((n) => n.code).filter(skipsOperation);
}

function omissionsOf(key: string) {
  return operation(key).notes.filter((n) => n.code === "input-property-omitted");
}

function names(key: string): string[] {
  return operation(key).input.map((f) => f.name);
}

const decisionsFor = (operationKey: string, capabilityId: string, resourceName?: string): DecisionRecord => ({
  version: "0",
  company: { id: "acme", name: "Acme Crate" },
  provider: "acme-api",
  decisions: [{ operation: operationKey, keep: true, capabilityId, effect: "write", ...(resourceName ? { resourceName } : {}) }],
});

describe("#64 — an optional nested-object body property is omitted, not refused", () => {
  const KEY = "POST /v1/shipments";

  it("is not refused, and `preferences` is absent from the input fields", () => {
    expect(refusals(KEY)).toEqual([]);
    expect(names(KEY)).toEqual(["destination"]);
  });

  it("carries an `input-property-omitted` note naming `preferences` as an object", () => {
    const omitted = omissionsOf(KEY);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.target).toMatch(/#preferences$/);
    expect(omitted[0]!.detail).toBe("object");
  });

  it("the emitted capability carries a comment naming the omission", () => {
    const result = emit(crate, decisionsFor(KEY, "shipments.create", "Shipment"));
    const capability = result.files.get("shipments.create.capability.yaml")!;
    expect(capability).toMatch(/omitted by init/);
    expect(capability).toMatch(/preferences \(object\)/);
  });
});

describe("#64 — an optional array-of-objects body property is omitted, not refused", () => {
  const KEY = "POST /v1/shipments/{id}/labels";

  it("is not refused, and `annotations` is absent from the input fields", () => {
    expect(refusals(KEY)).toEqual([]);
    expect(names(KEY)).toEqual(["id", "carrier"]);
  });

  it("carries an `input-property-omitted` note naming `annotations` as an array of object", () => {
    const omitted = omissionsOf(KEY);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.target).toMatch(/#annotations$/);
    expect(omitted[0]!.detail).toBe("array of object");
  });
});

describe("#64 — an optional object-valued query parameter is omitted, not refused", () => {
  const KEY = "GET /v1/shipments/search";

  it("is not refused, and `filter` is absent from the input fields", () => {
    expect(refusals(KEY)).toEqual([]);
    expect(names(KEY)).toEqual(["carrier"]);
  });

  it("carries an `input-property-omitted` note naming `filter`", () => {
    const omitted = omissionsOf(KEY);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.target).toMatch(/#filter$/);
  });
});

describe("#64/BR-3/BR-4 — required (even if nullable) always refuses, never omits", () => {
  it("a required-but-nullable body property still refuses (window)", () => {
    const key = "POST /v1/shipments/{id}/schedule";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(omissionsOf(key)).toEqual([]);
    const result = emit(crate, decisionsFor(key, "shipments.thing"));
    expect(result.files.size).toBe(0);
  });

  it("a required-but-nullable object-valued query parameter still refuses (area)", () => {
    const key = "GET /v1/shipments/nearby";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(omissionsOf(key)).toEqual([]);
    const result = emit(crate, decisionsFor(key, "shipments.thing"));
    expect(result.files.size).toBe(0);
  });

  it("a non-scalar property in required[] still refuses even when the requestBody itself is optional (BR-2/BR-3/EC-1)", () => {
    // Trap 2 (PM note) / EC-1: `requestBody.required: false` makes every property optional
    // WHEN nothing else says otherwise — but the schema's own `required[]` is a stronger,
    // independent fact, and it still names `contents`. Reading `bodyRequired` as if it
    // rescued this property would omit a field the backend's own contract demands.
    const key = "POST /v1/shipments/{id}/manifest";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(omissionsOf(key)).toEqual([]);
    const result = emit(crate, decisionsFor(key, "shipments.thing"));
    expect(result.files.size).toBe(0);
  });
});

describe("#64/BR-9 — the floor: omission cannot leave a tool with no inputs", () => {
  it("an operation whose only property is optional-and-unsupported, with no parameters, is refused", () => {
    const key = "POST /v1/shipments/metadata";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    // No phantom omission note for a candidate that never reaches the gate (BR-9).
    expect(omissionsOf(key)).toEqual([]);
    const result = emit(crate, decisionsFor(key, "shipments.thing"));
    expect(result.files.size).toBe(0);
  });
});

describe("no new report allowlist — the code reuses the existing grouping (BR-12, R-6)", () => {
  it("every note raised by this document is either the new code or one that already existed", () => {
    const used = new Set(crate.operations.flatMap((o) => o.notes.map((n) => n.code)));
    for (const code of used) {
      expect(
        ["unsupported-parameter-location", "input-property-omitted", "semantic-type-degraded"],
        `unexpected reason code '${code}' — adding one is a scope decision`,
      ).toContain(code);
    }
  });
});
