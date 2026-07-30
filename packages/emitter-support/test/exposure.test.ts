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

  it("retired: unlisted, NOT invocable, blockedReason 'retired' — a governance refusal (ADD-56 D-2)", () => {
    expect(lifecycleExposure("retired")).toEqual({ listed: false, invocable: false, blockedReason: "retired" });
  });

  it("every lifecycle state produces a defined listed/invocable pair (no state falls through undefined)", () => {
    for (const l of LIFECYCLES) {
      const e = lifecycleExposure(l);
      expect(typeof e.listed).toBe("boolean");
      expect(typeof e.invocable).toBe("boolean");
    }
  });
});

// ADD-56 (#56) D-1/D-2/D-3: an unrecognized `lifecycle` value — the ONLY reachable trigger is a
// hand-written or forward-versioned `fromIR` artifact (ADD-0008 D-2), simulated here at the
// pure-function level by widening the parameter type past `Lifecycle`'s closed union, exactly
// the way an `as IR` cast lets an untrusted value reach this function in production.
describe("lifecycleExposure — fail-closed on an unrecognized lifecycle (ADD-56 D-1)", () => {
  it("BR-1/EC-1: an unrecognized string is refused, distinct from retired's blockedReason", () => {
    const e = lifecycleExposure("sunset" as Lifecycle);
    expect(e).toEqual({ listed: false, invocable: false, blockedReason: "unevaluatable" });
  });

  it("BR-1/EC-2: a non-string value (number) is refused identically — the gate is type-agnostic", () => {
    expect(lifecycleExposure(7 as unknown as Lifecycle)).toEqual({
      listed: false,
      invocable: false,
      blockedReason: "unevaluatable",
    });
  });

  it("BR-1/EC-2: null and undefined are refused identically", () => {
    expect(lifecycleExposure(null as unknown as Lifecycle)).toEqual({
      listed: false,
      invocable: false,
      blockedReason: "unevaluatable",
    });
    expect(lifecycleExposure(undefined as unknown as Lifecycle)).toEqual({
      listed: false,
      invocable: false,
      blockedReason: "unevaluatable",
    });
  });

  it("BR-2: never returns undefined — the function is total", () => {
    const e = lifecycleExposure("some-future-state" as Lifecycle);
    expect(e).toBeDefined();
    expect(e.listed).toBe(false);
    expect(e.invocable).toBe(false);
  });

  it("EC-4: a near-miss spelling of 'retired' is treated as unrecognized, never coerced (case-sensitive, no trimming)", () => {
    expect(lifecycleExposure("Retired" as Lifecycle).blockedReason).toBe("unevaluatable");
    expect(lifecycleExposure("retired " as Lifecycle).blockedReason).toBe("unevaluatable");
  });

  it("BR-16: no recognized state other than retired ever produces blockedReason 'retired', and no state other than an unrecognized value ever produces 'unevaluatable'", () => {
    for (const l of LIFECYCLES) {
      const e = lifecycleExposure(l);
      if (l === "retired") {
        expect(e.blockedReason).toBe("retired");
      } else {
        expect(e.blockedReason).toBeUndefined();
      }
    }
    expect(lifecycleExposure("sunset" as Lifecycle).blockedReason).toBe("unevaluatable");
  });
});

// Finding 1 (§0.3 of the AC) / EC-7: before ADD-56, `combineExposure` read `.hint` off the
// `undefined` value `lifecycleExposure` used to return for an unrecognized lifecycle, throwing a
// synchronous TypeError whenever a health reading also covered that tool. D-1 closes this as a
// side effect, with no separate code change — `lifecycleExposure` is now total, so `base` can
// never be `undefined` here.
describe("combineExposure — the ADD-56 Finding-1 crash mode is closed (EC-7)", () => {
  it("does not throw when composing an unrecognized-lifecycle base with a non-green health reading", () => {
    const base = lifecycleExposure("sunset" as Lifecycle);
    expect(() => combineExposure(base, "yellow")).not.toThrow();
    expect(() => combineExposure(base, "red")).not.toThrow();
  });

  it("an unrecognized-lifecycle tool stays invocable:false/listed:false regardless of health, and health never re-opens it (mirrors D-9's retired guarantee)", () => {
    for (const h of HEALTHS) {
      const combined = combineExposure(lifecycleExposure("sunset" as Lifecycle), h);
      expect(combined.invocable).toBe(false);
      expect(combined.listed).toBe(false);
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
