import { describe, it, expect } from "vitest";
import { describeShape, fingerprintShape, fingerprintShapeMap } from "../src/fingerprint";

describe("fingerprintShape (ADD-18)", () => {
  it("is stable across value variation (same keys/types, different data)", () => {
    const a = { stays: [{ name: "Hotel A", price: 100, rating: 4.5 }] };
    const b = { stays: [{ name: "Hotel B", price: 200, rating: 3.1 }] };
    expect(fingerprintShape(a)).toBe(fingerprintShape(b));
  });

  it("changes when a key is renamed", () => {
    const a = { stays: [{ name: "Hotel A", price: 100 }] };
    const b = { stays: [{ name: "Hotel A", cost: 100 }] };
    expect(fingerprintShape(a)).not.toBe(fingerprintShape(b));
  });

  it("changes when a value's type changes", () => {
    const a = { price: 100 };
    const b = { price: "100" };
    expect(fingerprintShape(a)).not.toBe(fingerprintShape(b));
  });

  it("is insensitive to key order", () => {
    const a = { name: "X", price: 1 };
    const b = { price: 1, name: "X" };
    expect(fingerprintShape(a)).toBe(fingerprintShape(b));
  });

  it("distinguishes an empty array from an absent one", () => {
    const withEmpty = fingerprintShape({ stays: [] });
    const without = fingerprintShape({});
    expect(withEmpty).not.toBe(without);
  });

  it("is prefixed sha256: and stable for a fixed input", () => {
    const fp = fingerprintShape({ a: 1 });
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintShape({ a: 1 })).toBe(fp);
  });
});

describe("ADD-114 — the refactor must not move a shipped fingerprint", () => {
  // The value committed in examples/manifests/tourism/bindings/tourism.search.binding.yaml.
  // Every contract recorded in the wild depends on this hash. If describeShape's extraction
  // changed the canonical form, every one of them would go yellow on the next `verify` run
  // with no provider having changed anything — so this is pinned to the literal, not
  // recomputed from the implementation under test.
  const SHIPPED = "sha256:cabe202bbd2f2d4c6aef739c652a1fba3de20333539a1df42ea5cc187dfb1273";

  const mockStaysBody = {
    stays: [
      { id: "stay-5-0", name: "Riverside Lodge — Rome", location: "Rome", pricePerNight: 225, rating: 4.1 },
      { id: "stay-2-1", name: "The Olive Court — Rome", location: "Rome", pricePerNight: 278, rating: 4.5 },
    ],
  };

  it("still produces the fingerprint committed in the tourism binding", () => {
    expect(fingerprintShape(mockStaysBody)).toBe(SHIPPED);
  });
});

describe("describeShape (ADD-114 D-1/D-5)", () => {
  it("returns the same paths and types the fingerprint is built from", () => {
    expect(describeShape({ stays: [{ name: "X", rating: 4.5 }] })).toEqual({
      $: "object",
      "$.stays": "array",
      "$.stays[]": "object",
      "$.stays[].name": "string",
      "$.stays[].rating": "number",
    });
  });

  it("shapes an array by its first element only", () => {
    const one = describeShape({ xs: [{ a: 1 }] });
    const many = describeShape({ xs: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    expect(one).toEqual(many);
  });

  it("records null as its own type rather than dropping the path", () => {
    expect(describeShape({ rating: null })["$.rating"]).toBe("null");
  });

  it("never records a value", () => {
    const shape = describeShape({ name: "Hotel Azur", pricePerNight: 225 });
    expect(JSON.stringify(shape)).not.toContain("Hotel Azur");
    expect(JSON.stringify(shape)).not.toContain("225");
  });
});

describe("fingerprintShapeMap (ADD-114 D-3)", () => {
  it("round-trips: re-deriving from a described shape reproduces the fingerprint", () => {
    const body = { stays: [{ name: "X", location: "Y", pricePerNight: 1, rating: 2 }], total: 3 };
    expect(fingerprintShapeMap(describeShape(body))).toBe(fingerprintShape(body));
  });

  it("is insensitive to the map's own key order", () => {
    const a = { $: "object", "$.b": "number", "$.a": "string" } as const;
    const b = { $: "object", "$.a": "string", "$.b": "number" } as const;
    expect(fingerprintShapeMap(a)).toBe(fingerprintShapeMap(b));
  });

  it("does NOT round-trip when a dotted key collides — the documented lossy case", () => {
    // describeShape keeps one of the two `$.a.b` entries; the pair list keeps both. D-3's
    // consistency check turns this into a "stale shape" report, never a wrong diff.
    const body = { "a.b": 1, a: { b: 2 } };
    expect(fingerprintShapeMap(describeShape(body))).not.toBe(fingerprintShape(body));
  });
});
