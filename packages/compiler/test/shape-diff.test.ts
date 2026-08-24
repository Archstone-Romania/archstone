import { describe, it, expect } from "vitest";
import { describeShape } from "../src/fingerprint";
import { diffShape, hasShapeDrift, shapeDriftSummary } from "../src/shape-diff";

const recorded = describeShape({
  stays: [{ name: "X", location: "Y", pricePerNight: 100, rating: 4.2 }],
});

describe("diffShape (ADD-114 D-4)", () => {
  it("reports nothing when the shape is unchanged", () => {
    const diff = diffShape(recorded, { ...recorded });
    expect(diff).toEqual({ added: [], removed: [], retyped: [] });
    expect(hasShapeDrift(diff)).toBe(false);
  });

  it("names fields the provider gained", () => {
    const live = describeShape({
      stays: [{ name: "X", location: "Y", pricePerNight: 100, rating: 4.2, boardType: "ALL_INCLUSIVE", refundable: true }],
    });
    const diff = diffShape(recorded, live);
    expect(diff.added).toEqual([
      { path: "$.stays[].boardType", type: "string" },
      { path: "$.stays[].refundable", type: "boolean" },
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.retyped).toEqual([]);
  });

  it("names fields the provider lost", () => {
    const live = describeShape({ stays: [{ name: "X", location: "Y", pricePerNight: 100 }] });
    const diff = diffShape(recorded, live);
    expect(diff.removed).toEqual([{ path: "$.stays[].rating", type: "number" }]);
    expect(diff.added).toEqual([]);
  });

  it("names a field that changed type, with both types", () => {
    const live = describeShape({
      stays: [{ name: "X", location: "Y", pricePerNight: "100", rating: 4.2 }],
    });
    const diff = diffShape(recorded, live);
    expect(diff.retyped).toEqual([{ path: "$.stays[].pricePerNight", from: "number", to: "string" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("reports all three at once", () => {
    const live = describeShape({
      stays: [{ name: "X", location: "Y", pricePerNight: "100", boardType: "HALF_BOARD" }],
    });
    const diff = diffShape(recorded, live);
    expect(diff.added.map((e) => e.path)).toEqual(["$.stays[].boardType"]);
    expect(diff.removed.map((e) => e.path)).toEqual(["$.stays[].rating"]);
    expect(diff.retyped.map((e) => e.path)).toEqual(["$.stays[].pricePerNight"]);
  });

  it("sorts by path so two runs report identically", () => {
    const live = describeShape({
      stays: [{ name: "X", location: "Y", pricePerNight: 1, rating: 2, zulu: 1, alpha: 1, mike: 1 }],
    });
    expect(diffShape(recorded, live).added.map((e) => e.path)).toEqual([
      "$.stays[].alpha",
      "$.stays[].mike",
      "$.stays[].zulu",
    ]);
  });

  it("treats a null-valued field as a retype, not an absence", () => {
    const live = describeShape({ stays: [{ name: "X", location: "Y", pricePerNight: 100, rating: null }] });
    const diff = diffShape(recorded, live);
    expect(diff.retyped).toEqual([{ path: "$.stays[].rating", from: "number", to: "null" }]);
    expect(diff.removed).toEqual([]);
  });
});

describe("shapeDriftSummary", () => {
  it("reads as one operator-facing sentence", () => {
    const live = describeShape({
      stays: [{ name: "X", location: "Y", pricePerNight: 100, rating: 4.2, boardType: "ALL_INCLUSIVE" }],
    });
    expect(shapeDriftSummary(diffShape(recorded, live))).toBe(
      "gained 1 field(s): $.stays[].boardType (string)",
    );
  });

  it("renders a retype with both types", () => {
    const live = describeShape({ stays: [{ name: "X", location: "Y", pricePerNight: "100", rating: 4.2 }] });
    expect(shapeDriftSummary(diffShape(recorded, live))).toBe(
      "retyped 1 field(s): $.stays[].pricePerNight (number → string)",
    );
  });

  it("is empty when nothing moved", () => {
    expect(shapeDriftSummary(diffShape(recorded, { ...recorded }))).toBe("");
  });
});
