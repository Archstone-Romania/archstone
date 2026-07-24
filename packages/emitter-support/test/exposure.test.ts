import { describe, it, expect } from "vitest";
import type { Lifecycle } from "@archstone/compiler";
import { lifecycleExposure, combineExposure, type HealthStatus } from "../src/exposure";

const LIFECYCLES: Lifecycle[] = ["experimental", "beta", "stable", "deprecated", "retired"];
const HEALTHS: HealthStatus[] = ["green", "yellow", "red"];

describe("lifecycleExposure (ADD-24 D-10)", () => {
  it("experimental: unlisted, invocable, no hint", () => {
    expect(lifecycleExposure("experimental")).toEqual({ listed: false, invocable: true });
  });

  it("beta: listed, invocable, caution hint", () => {
    const e = lifecycleExposure("beta");
    expect(e.listed).toBe(true);
    expect(e.invocable).toBe(true);
    expect(e.hint?.level).toBe("caution");
  });

  it("stable: listed, invocable, no hint", () => {
    expect(lifecycleExposure("stable")).toEqual({ listed: true, invocable: true });
  });

  it("deprecated: listed, invocable, deprecation hint", () => {
    const e = lifecycleExposure("deprecated");
    expect(e.listed).toBe(true);
    expect(e.invocable).toBe(true);
    expect(e.hint?.level).toBe("deprecation");
  });

  it("retired: unlisted, NOT invocable — the only state that blocks invocation", () => {
    expect(lifecycleExposure("retired")).toEqual({ listed: false, invocable: false });
  });

  it("every lifecycle state produces a defined listed/invocable pair (no state falls through undefined)", () => {
    for (const l of LIFECYCLES) {
      const e = lifecycleExposure(l);
      expect(typeof e.listed).toBe("boolean");
      expect(typeof e.invocable).toBe("boolean");
    }
  });
});

describe("combineExposure (ADD-24 D-9) — health only ever raises hint severity, never gates listed/invocable", () => {
  it("no health data leaves the lifecycle-derived exposure untouched, for every lifecycle state", () => {
    for (const l of LIFECYCLES) {
      const base = lifecycleExposure(l);
      expect(combineExposure(base)).toEqual(base);
    }
  });

  it("green health never adds a hint, for every lifecycle state", () => {
    for (const l of LIFECYCLES) {
      const base = lifecycleExposure(l);
      expect(combineExposure(base, "green")).toEqual(base);
    }
  });

  it("yellow health adds a caution hint to a stable tool (which had none)", () => {
    const combined = combineExposure(lifecycleExposure("stable"), "yellow");
    expect(combined.hint?.level).toBe("caution");
    expect(combined.listed).toBe(true);
    expect(combined.invocable).toBe(true);
  });

  it("red health raises a stable tool's hint to deprecation-level severity", () => {
    const combined = combineExposure(lifecycleExposure("stable"), "red");
    expect(combined.hint?.level).toBe("deprecation");
  });

  it("yellow health does not downgrade a beta tool's existing caution hint (equal severity keeps lifecycle's own text)", () => {
    const base = lifecycleExposure("beta");
    const combined = combineExposure(base, "yellow");
    expect(combined.hint).toEqual(base.hint);
  });

  it("red health raises a beta tool's caution hint to deprecation severity", () => {
    const combined = combineExposure(lifecycleExposure("beta"), "red");
    expect(combined.hint?.level).toBe("deprecation");
  });

  it("yellow/red health never changes a deprecated tool's already-deprecation-level hint text", () => {
    const base = lifecycleExposure("deprecated");
    expect(combineExposure(base, "yellow").hint).toEqual(base.hint);
    expect(combineExposure(base, "red").hint).toEqual(base.hint);
  });

  it("D-9: health NEVER sets invocable:false — an experimental (invocable) tool stays invocable at every health reading", () => {
    for (const h of HEALTHS) {
      expect(combineExposure(lifecycleExposure("experimental"), h).invocable).toBe(true);
    }
  });

  it("D-9: health NEVER re-opens a retired (invocable:false) tool at any health reading", () => {
    for (const h of HEALTHS) {
      expect(combineExposure(lifecycleExposure("retired"), h).invocable).toBe(false);
    }
  });

  it("D-9: health NEVER changes `listed`, for every lifecycle x health combination", () => {
    for (const l of LIFECYCLES) {
      const base = lifecycleExposure(l);
      for (const h of HEALTHS) {
        expect(combineExposure(base, h).listed).toBe(base.listed);
      }
    }
  });
});
