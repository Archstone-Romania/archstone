import { describe, it, expect } from "vitest";
import { absent, declared, isKnown, observed, valueOr, valueOrUndefined, baseUrlEnvVar, providerId, keptDecisions, reasonSummary, skipsOperation, REASON_CODES, type DecisionRecord } from "@archstone/init";

// The Draft Model's one load-bearing property (D-2) and the Decision Record's one
// load-bearing property (D-3/D-4), asserted directly.

describe("Fact — a value never travels without its derivation", () => {
  it("carries where it came from", () => {
    expect(declared("Nice", "#/components/schemas/Stay.location")).toEqual({
      derivation: "declared",
      value: "Nice",
      source: "#/components/schemas/Stay.location",
    });
    expect(observed(3, "$.items[0].adults")).toMatchObject({ derivation: "observed", value: 3 });
  });

  it("an absent fact carries NO value — the absence is the fact, not a default", () => {
    const fact = absent<string>("the source declared no type");
    expect(isKnown(fact)).toBe(false);
    expect(Object.keys(fact)).not.toContain("value");
    expect(valueOrUndefined(fact)).toBeUndefined();
  });

  it("a fallback is always visible at the call site — there is no API that invents one", () => {
    expect(valueOr(absent<string>(), "string")).toBe("string");
    expect(valueOr(declared("text"), "string")).toBe("text");
  });
});

describe("the reason-code list — the scope boundary, made visible", () => {
  it("every code says whether it skips the candidate or merely degrades it", () => {
    for (const code of Object.keys(REASON_CODES) as (keyof typeof REASON_CODES)[]) {
      expect(typeof skipsOperation(code)).toBe("boolean");
      expect(reasonSummary(code).length).toBeGreaterThan(0);
    }
  });

  it("a skip and a degradation are never the same code", () => {
    expect(skipsOperation("ambiguous-collection")).toBe(true);
    expect(skipsOperation("nested-object-not-mapped")).toBe(false);
  });
});

describe("the Decision Record", () => {
  const record: DecisionRecord = {
    version: "0",
    company: { id: "acme" },
    decisions: [
      { operation: "GET /a", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
      { operation: "POST /b", keep: false, note: "internal endpoint" },
    ],
  };

  it("kept decisions carry a confirmed effect — the type has no arm where one is missing", () => {
    const kept = keptDecisions(record);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.effect).toBe("read");
  });

  it("defaults the provider and the base-URL env var from the company id, and both are overridable", () => {
    expect(providerId(record)).toBe("acme-api");
    expect(baseUrlEnvVar(record)).toBe("ACME_API_URL");
    expect(baseUrlEnvVar({ ...record, company: { id: "north-wind" } })).toBe("NORTH_WIND_API_URL");
    expect(providerId({ ...record, provider: "legacy-crm" })).toBe("legacy-crm");
  });
});
