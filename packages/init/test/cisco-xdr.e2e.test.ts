import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiAdapter, skipsOperation, type ReasonCode } from "@archstone/init";

// Issue #63's own acceptance bar (BR-16, founder-amended): "Cisco XDR bar amended to 9/11
// candidates. POST /iroh/ctia/malware and PUT /iroh/ctia/malware/{id} still refuse on
// `external_references` (array of objects) — follow-up issue." This is a vendored, SYNTHETIC
// stand-in for the real document (see the fixture's own header) — never the licensed original.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const xdr = openApiAdapter.adapt({ origin: "cisco-xdr-malware.yaml", document: read("cisco-xdr-malware.yaml"), documents: {} });

function refusals(key: string): ReasonCode[] {
  const op = xdr.operations.find((o) => o.key === key)!;
  return op.notes.map((n) => n.code).filter(skipsOperation);
}

function detailOf(key: string): string {
  const op = xdr.operations.find((o) => o.key === key)!;
  return op.notes.filter((n) => skipsOperation(n.code)).map((n) => n.detail ?? "").join(" ");
}

describe("Cisco XDR Malware API (#63 e2e, founder-amended bar)", () => {
  it("declares exactly 11 operations", () => {
    expect(xdr.operations).toHaveLength(11);
  });

  it("9 of 11 operations are candidates — no refusal from the three narrowed conditions", () => {
    const candidates = xdr.operations.filter((o) => refusals(o.key).length === 0);
    expect(candidates).toHaveLength(9);
  });

  it("POST /iroh/ctia/malware still refuses, naming `external_references`", () => {
    const key = "POST /iroh/ctia/malware";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(detailOf(key)).toMatch(/external_references/);
  });

  it("PUT /iroh/ctia/malware/{id} still refuses, naming `external_references`", () => {
    const key = "PUT /iroh/ctia/malware/{id}";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(detailOf(key)).toMatch(/external_references/);
  });

  it("the 9 named candidates are exactly the operations exercising Goals 1/2/3", () => {
    const expectedCandidates = [
      "GET /iroh/ctia/malware", // Goal 1: fields/search_after list query params
      "GET /iroh/ctia/malware/{id}",
      "DELETE /iroh/ctia/malware/{id}", // Goal 2: wait_for query alongside an (optional) body
      "PATCH /iroh/ctia/malware/{id}/labels", // Goal 3: labels array-of-scalars body property
      "DELETE /iroh/ctia/malware/{id}/labels", // Goal 1: names list query param
      "GET /iroh/ctia/malware/search", // Goal 1: non-exploded fields list
      "GET /iroh/ctia/malware/{id}/relationships", // Goal 1: search_after list
      "GET /iroh/ctia/malware/count", // Goal 1: filter list
      "POST /iroh/ctia/malware/{id}/quote", // Goal 2: dryRun query alongside body
    ];
    const actual = xdr.operations.filter((o) => refusals(o.key).length === 0).map((o) => o.key);
    expect(actual.sort()).toEqual(expectedCandidates.sort());
  });
});
