import { describe, it, expect } from "vitest";
import type { IRResourceRegistry, IRTool, ShapeDiff } from "@archstone/compiler";
import { planAdoption, adoptable } from "../src/adopt";

const resources: IRResourceRegistry = {
  Stay: [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
    { name: "pricePerNight", required: true, type: { kind: "scalar", semantic: "quantity" } },
    { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
  ],
};

function tool(collection: string | null = "$.stays[*]"): IRTool {
  return {
    id: "tourism.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }],
    connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/search" } },
    response: {
      resource: "Stay",
      field: "stays",
      ...(collection ? { collection } : {}),
      fields: [
        { name: "name", path: "$.name" },
        { name: "location", path: "$.location" },
        { name: "pricePerNight", path: "$.pricePerNight" },
        { name: "rating", path: "$.rating" },
      ],
    },
  };
}

const drift = (added: ShapeDiff["added"]): ShapeDiff => ({ added, removed: [], retyped: [] });

describe("planAdoption — what can be declared (ADD-117 D-5, §3)", () => {
  it("adopts a string as text and a number as quantity", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].boardType", type: "string" },
        { path: "$.stays[].distanceToBeachM", type: "number" },
      ]),
      resources,
    );
    expect(adoptable(plan)).toEqual([
      { adoptable: true, path: "$.stays[].boardType", field: "boardType", itemPath: "$.boardType", observed: "string", semantic: "text" },
      { adoptable: true, path: "$.stays[].distanceToBeachM", field: "distanceToBeachM", itemPath: "$.distanceToBeachM", observed: "number", semantic: "quantity" },
    ]);
    expect(plan.resource).toBe("Stay");
  });

  it("does NOT infer date from a string, however date-shaped the field name is", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].freeCancellationUntil", type: "string" }]), resources);
    // The shape records types, never values — there is nothing to pattern-match, and guessing
    // from a name is the guess this project refuses. The human can widen it afterwards.
    expect(adoptable(plan)[0].semantic).toBe("text");
  });

  it("does NOT infer money from a number", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].net", type: "number" }]), resources);
    expect(adoptable(plan)[0].semantic).toBe("quantity");
  });

  it("refuses a boolean, because CDL has no boolean semantic type", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].refundable", type: "boolean" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "no-boolean-type" });
    expect(adoptable(plan)).toEqual([]);
  });

  it("refuses a structure rather than declaring it", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].amenities", type: "array" },
        { path: "$.stays[].address", type: "object" },
        { path: "$.stays[].cancelledAt", type: "null" },
      ]),
      resources,
    );
    expect(plan.candidates.map((c) => (c.adoptable ? "adopted" : c.reason))).toEqual([
      "not-a-leaf",
      "not-a-leaf",
      "not-a-leaf",
    ]);
  });

  it("refuses a nested path", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].address.city", type: "string" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "nested" });
  });

  it("refuses a path outside the mapped collection", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.totalResults", type: "number" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "outside-collection" });
  });

  it("refuses a field the capability already declares — by mapping or by resource", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].rating", type: "number" },
        { path: "$.stays[].location", type: "string" },
      ]),
      resources,
    );
    expect(plan.candidates.every((c) => !c.adoptable && c.reason === "already-declared")).toBe(true);
  });

  it("every refusal carries a sentence, so nothing is silently dropped", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].refundable", type: "boolean" },
        { path: "$.total", type: "number" },
      ]),
      resources,
    );
    for (const c of plan.candidates) {
      if (!c.adoptable) expect(c.detail.length).toBeGreaterThan(10);
    }
    expect(plan.candidates).toHaveLength(2);
  });

  it("handles a single-object response, whose fields hang off the root", () => {
    const plan = planAdoption(tool(null), drift([{ path: "$.boardType", type: "string" }]), resources);
    expect(adoptable(plan)[0]).toMatchObject({ field: "boardType", itemPath: "$.boardType" });
  });

  it("considers only added paths — removed and retyped are out of scope (ADR-0008)", () => {
    const plan = planAdoption(
      tool(),
      {
        added: [],
        removed: [{ path: "$.stays[].net", type: "number" }],
        retyped: [{ path: "$.stays[].pricePerNight", from: "number", to: "string" }],
      },
      resources,
    );
    expect(plan.candidates).toEqual([]);
  });

  it("plans nothing for a capability with no response mapping", () => {
    const t = tool();
    delete t.response;
    expect(planAdoption(t, drift([{ path: "$.x", type: "string" }]), resources)).toEqual({
      capabilityId: "tourism.search",
      candidates: [],
    });
  });
});
