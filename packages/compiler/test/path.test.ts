import { describe, it, expect } from "vitest";
import { parsePath, evalPath } from "../src/path";

describe("parsePath — compile-time JSONPath syntax check", () => {
  it.each(["$.name", "$.results[*].price", "$.rooms[?(@.available)].price.total", "$..amenities[*]"])(
    "accepts valid path %s",
    (p) => {
      expect(parsePath(p).ok).toBe(true);
    },
  );

  it("rejects a malformed path", () => {
    const r = parsePath("$.[");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });
});

describe("evalPath — runtime evaluation", () => {
  it("returns the match list for a member path", () => {
    expect(evalPath({ name: "A" }, "$.name")).toEqual(["A"]);
  });

  it("returns each element for a collection wildcard", () => {
    expect(evalPath({ xs: [{ v: 1 }, { v: 2 }] }, "$.xs[*].v")).toEqual([1, 2]);
  });

  it("applies a filter expression (full JSONPath)", () => {
    const body = { rooms: [{ available: true, price: 90 }, { available: false, price: 70 }] };
    expect(evalPath(body, "$.rooms[?(@.available)].price")).toEqual([90]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(evalPath({ name: "A" }, "$.missing")).toEqual([]);
  });
});
