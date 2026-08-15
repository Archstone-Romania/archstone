import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import {
  evaluateRateLimit,
  InMemoryRateLimitCounter,
  type RateLimitCounter,
  type RateLimitDecision,
} from "../src/ratelimit";

// #45 / ADD-45 — the rate-limit evaluation step, unit-tested in isolation, mirroring
// policy.test.ts's discipline: every rule the two consumers (`callTool`, `executeCapability`)
// rely on is pinned here once.

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "banking.list-accounts",
    description: "List accounts.",
    effect: "read",
    provider: "core-banking",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    ...over,
  };
}

function reasonOf(d: RateLimitDecision): string | undefined {
  return d.allowed ? undefined : d.denial.reason;
}

const rl = (maxInvocations: number, windowSeconds: number) => ({ maxInvocations, windowSeconds });

describe("InMemoryRateLimitCounter — increments and window boundary", () => {
  it("increments correctly within one window", () => {
    let now = 0;
    const c = new InMemoryRateLimitCounter(() => now);
    expect(c.increment("k", 60)).toBe(1);
    now += 1000;
    expect(c.increment("k", 60)).toBe(2);
    now += 1000;
    expect(c.increment("k", 60)).toBe(3);
  });

  it("keeps independent counts per key", () => {
    const c = new InMemoryRateLimitCounter(() => 0);
    expect(c.increment("a", 60)).toBe(1);
    expect(c.increment("b", 60)).toBe(1);
    expect(c.increment("a", 60)).toBe(2);
    expect(c.increment("b", 60)).toBe(2);
  });

  it("resets to 1 once windowSeconds has elapsed (a fresh window)", () => {
    let now = 0;
    const c = new InMemoryRateLimitCounter(() => now);
    expect(c.increment("k", 10)).toBe(1);
    now = 10_001; // just past one 10s window
    expect(c.increment("k", 10)).toBe(1);
  });

  // The window-boundary edge case the DoD names explicitly: a request landing EXACTLY on the
  // boundary instant belongs to the NEW window, because `Math.floor(now / windowMs) * windowMs`
  // puts that instant at the start of the bucket beginning there, not the end of the one before.
  it("a request exactly AT the window boundary starts a new window", () => {
    let now = 0;
    const c = new InMemoryRateLimitCounter(() => now);
    const windowMs = 10_000;
    expect(c.increment("k", 10)).toBe(1); // window [0, 10000)
    now = windowMs - 1; // 9999ms — still inside the first window
    expect(c.increment("k", 10)).toBe(2);
    now = windowMs; // exactly 10000ms — the boundary instant itself
    expect(c.increment("k", 10)).toBe(1); // new window, count resets
  });

  it("a request one millisecond BEFORE the boundary still counts in the old window", () => {
    let now = 9_999;
    const c = new InMemoryRateLimitCounter(() => now);
    expect(c.increment("k", 10)).toBe(1);
    now = 9_999; // same instant, same window
    expect(c.increment("k", 10)).toBe(2);
  });

  it("defaults to the real wall clock when no `now` is injected", () => {
    const c = new InMemoryRateLimitCounter();
    expect(c.increment("k", 60)).toBe(1);
    expect(c.increment("k", 60)).toBe(2);
  });
});

describe("evaluateRateLimit — negative control: no rateLimit rule (#45 DoD)", () => {
  it("allows, and never touches the counter, when the tool has no policyRules at all", async () => {
    const counter: RateLimitCounter = { increment: vi.fn() };
    const d = await evaluateRateLimit(tool(), {}, counter);
    expect(d.allowed).toBe(true);
    expect(counter.increment).not.toHaveBeenCalled();
  });

  it("allows, and never touches the counter, when policyRules has no rateLimit-bearing rule", async () => {
    const counter: RateLimitCounter = { increment: vi.fn() };
    const t = tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] });
    const d = await evaluateRateLimit(t, { principal: "user:alice" }, counter);
    expect(d.allowed).toBe(true);
    expect(counter.increment).not.toHaveBeenCalled();
  });
});

describe("evaluateRateLimit — the no-store default is fail-CLOSED (#45 DoD)", () => {
  it("denies with policy_unevaluatable when rateLimit is declared and no counter is supplied", async () => {
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(5, 60) }] });
    const d = await evaluateRateLimit(t, { principal: "user:alice" }, undefined);
    expect(d.allowed).toBe(false);
    expect(reasonOf(d)).toBe("policy_unevaluatable");
  });
});

describe("evaluateRateLimit — exceeding the limit (#45 DoD)", () => {
  it("allows invocations up to and including maxInvocations within windowSeconds", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(3, 60) }] });
    for (let i = 0; i < 3; i++) {
      const d = await evaluateRateLimit(t, { principal: "user:alice" }, counter);
      expect(d.allowed).toBe(true);
    }
  });

  it("denies the invocation that exceeds maxInvocations, with a distinct reason code", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(2, 60) }] });
    await evaluateRateLimit(t, { principal: "user:alice" }, counter);
    await evaluateRateLimit(t, { principal: "user:alice" }, counter);
    const d = await evaluateRateLimit(t, { principal: "user:alice" }, counter);
    expect(d.allowed).toBe(false);
    expect(reasonOf(d)).toBe("rate_limit_exceeded");
    expect(reasonOf(d)).not.toBe("policy_unevaluatable");
    expect(reasonOf(d)).not.toBe("principal_not_allowed");
    expect(reasonOf(d)).not.toBe("principal_denied");
    expect(reasonOf(d)).not.toBe("authenticated_no_credential");
  });

  it("allows again once the window has rolled over", async () => {
    let now = 0;
    const counter = new InMemoryRateLimitCounter(() => now);
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(1, 10) }] });
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(true);
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(false);
    now = 10_000; // window boundary — a fresh window
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(true);
  });

  it("supports an async counter (Promise<number>)", async () => {
    const counter: RateLimitCounter = { increment: async () => 99 };
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(1, 60) }] });
    const d = await evaluateRateLimit(t, { principal: "user:alice" }, counter);
    expect(d.allowed).toBe(false);
    expect(reasonOf(d)).toBe("rate_limit_exceeded");
  });
});

// Bug fix (found reviewing #45): the original `for` loop called `counter.increment` per rule in
// ARRAY order and returned (denied) as soon as one rule's count exceeded its max — rules AFTER
// the denying one were never touched for that call, while rules BEFORE it were already
// incremented even though the call was ultimately denied. That makes metering order-dependent:
// which rule "sees" a given attempt depended on `tool.policyRules`'s array order, not on the
// manifest's declared semantics, and a call denied by a strict rule could still fail to consume
// a looser rule's shared budget purely because the looser rule was listed after it. The fix:
// every rateLimit-bearing rule sees every attempt (increment ALL, via `Promise.all`), THEN check
// whether ANY was exceeded — deterministic regardless of array order.
describe("evaluateRateLimit — every governing rule sees every attempt, deterministically (bug fix, found reviewing #45)", () => {
  function countingCounter(): { counter: RateLimitCounter; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    return {
      counts,
      counter: {
        increment: (key: string) => {
          counts[key] = (counts[key] ?? 0) + 1;
          return counts[key];
        },
      },
    };
  }

  it("denial outcome and the loose rule's resulting count are IDENTICAL regardless of rule array order", async () => {
    const strictRule = { id: "strict", rateLimit: rl(1, 60) };
    const looseRule = { id: "loose", rateLimit: rl(100, 60) };

    const strictFirst = tool({ id: "t", policyRules: [strictRule, looseRule] });
    const looseFirst = tool({ id: "t", policyRules: [looseRule, strictRule] });

    const a = countingCounter();
    const b = countingCounter();

    // Two calls against each ordering — the second call exceeds the strict rule's limit (1).
    await evaluateRateLimit(strictFirst, { principal: "user:alice" }, a.counter);
    const dStrictFirst = await evaluateRateLimit(strictFirst, { principal: "user:alice" }, a.counter);

    await evaluateRateLimit(looseFirst, { principal: "user:alice" }, b.counter);
    const dLooseFirst = await evaluateRateLimit(looseFirst, { principal: "user:alice" }, b.counter);

    // Same outcome regardless of order.
    expect(dStrictFirst.allowed).toBe(false);
    expect(dLooseFirst.allowed).toBe(false);
    expect(reasonOf(dStrictFirst)).toBe("rate_limit_exceeded");
    expect(reasonOf(dLooseFirst)).toBe("rate_limit_exceeded");

    // The loose rule's counter was incremented on EVERY call, in both orderings — not skipped
    // just because it came after (or before) the rule that ultimately denied.
    expect(a.counts["loose::user:alice"]).toBe(2);
    expect(b.counts["loose::user:alice"]).toBe(2);
    expect(a.counts["loose::user:alice"]).toBe(b.counts["loose::user:alice"]);
  });
});

describe("evaluateRateLimit — key derivation (#45 DoD)", () => {
  it("keys by capability AND principal — two different principals get independent buckets", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(1, 60) }] });
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(true);
    // Alice is now over her limit, but Bob has never called — a separate bucket.
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(false);
    expect((await evaluateRateLimit(t, { principal: "user:bob" }, counter)).allowed).toBe(true);
  });

  it("with no principal (anonymous), all anonymous callers of the capability share ONE bucket", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const t = tool({ policyRules: [{ id: "p", rateLimit: rl(1, 60) }] });
    expect((await evaluateRateLimit(t, {}, counter)).allowed).toBe(true);
    // A second anonymous call — same shared bucket, now exhausted.
    expect((await evaluateRateLimit(t, {}, counter)).allowed).toBe(false);
  });

  // Bug fix (found reviewing #45): `rateLimitKey` no longer folds in `capabilityId`. A
  // provider-scoped policy's rule carries the SAME `rule.id` (the policy's globally-unique
  // `metadata.id`, BR-4) on every capability under that provider (`lowerPolicyRules`), so two
  // DIFFERENT tools sharing a rule id are two capabilities governed by ONE provider-scoped
  // policy and MUST share one bucket — keying by capabilityId as well used to split that one
  // shared bucket into N independent ones, silently multiplying the effective limit by N.
  it("keys by rule id ALONE (not capability) — two tools sharing a provider-scoped rule id share ONE bucket", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    // Simulates a provider-scoped policy lowered onto two capabilities under the same provider —
    // both carry the identical rule id, as `lowerPolicyRules` produces.
    const a = tool({ id: "a", policyRules: [{ id: "provider-wide", rateLimit: rl(2, 60) }] });
    const b = tool({ id: "b", policyRules: [{ id: "provider-wide", rateLimit: rl(2, 60) }] });
    // Combined invocations across BOTH capabilities share the budget: 2 allowed total, not 2 each.
    expect((await evaluateRateLimit(a, { principal: "user:alice" }, counter)).allowed).toBe(true);
    expect((await evaluateRateLimit(b, { principal: "user:alice" }, counter)).allowed).toBe(true);
    // The third invocation, regardless of which capability it's against, must now be denied —
    // the combined count (3) exceeds maxInvocations (2).
    expect((await evaluateRateLimit(a, { principal: "user:alice" }, counter)).allowed).toBe(false);
  });

  // A capability-scoped rule's id is unique to that one capability (no other tool's
  // `policyRules` ever resolves the same rule id), so keying by rule id alone still isolates it
  // — nothing else can collide with it.
  it("a capability-scoped rule id (unique to one tool) remains isolated even without capabilityId in the key", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const a = tool({ id: "a", policyRules: [{ id: "a-only-rule", rateLimit: rl(1, 60) }] });
    const b = tool({ id: "b", policyRules: [{ id: "b-only-rule", rateLimit: rl(1, 60) }] });
    expect((await evaluateRateLimit(a, { principal: "user:alice" }, counter)).allowed).toBe(true);
    expect((await evaluateRateLimit(b, { principal: "user:alice" }, counter)).allowed).toBe(true);
    expect((await evaluateRateLimit(a, { principal: "user:alice" }, counter)).allowed).toBe(false);
  });

  it("keys by policy rule id — two rateLimit rules on one tool get independent buckets", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const t = tool({
      policyRules: [
        { id: "provider-wide", rateLimit: rl(1, 60) },
        { id: "capability-specific", rateLimit: rl(1, 60) },
      ],
    });
    // The first rule allows the first call, then the second rule ALSO evaluates (both attached
    // to the same tool) and allows too — but a second call must fail on the first rule.
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(true);
    expect((await evaluateRateLimit(t, { principal: "user:alice" }, counter)).allowed).toBe(false);
  });
});
