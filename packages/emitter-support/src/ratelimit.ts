// @archstone/emitter-support — rate-limit evaluation (#45 / ADD-45)
//
// `spec.rateLimit` (`policy.schema.json`) is the second half of the evaluation point #43 split
// deliberately: `allow`/`deny` are pure functions of `(tool, principal)`, and `evaluatePolicy`
// (`policy.ts`) stays exactly that. `rateLimit` needs a COUNT of prior invocations — state — so
// it cannot live inside that pure function without dragging I/O into the one place ADD-43
// promises has none. It is instead a separate, sibling evaluation step, `evaluateRateLimit`,
// called at the SAME two call sites (`callTool`, `executeCapability`) immediately after
// `evaluatePolicy` allows and strictly before `invokeRest` — same "deny before any connector
// work" invariant, same `policy_denied` response shape, one new reason code.
//
// `verifyTool` (the third #43 consumer) deliberately does NOT call this — rate-limiting
// `archstone verify` probes is explicit out-of-scope for #45.

import type { IRTool } from "@archstone/compiler";
import type { PolicyDenialReason } from "./policy";

/**
 * The counter a deployer supplies. Intentionally the smallest possible seam: ONE method,
 * returning the invocation count for `key` within the CURRENT window after this call is
 * counted (i.e. the first call in a fresh window returns `1`).
 *
 * Sync or async — `number | Promise<number>`, mirroring `InvokeOptions.onResponse`'s
 * `void | Promise<void>` in `@archstone/provider-rest`: a deployer backed by an in-process Map
 * can return a bare number; one backed by a Durable Object, Redis, or Upstash returns a Promise.
 * `evaluateRateLimit` always `await`s the result, so both shapes cost the caller nothing.
 *
 * Windowing semantics (fixed vs. sliding, exact boundary behaviour) are the IMPLEMENTATION's
 * decision, not this interface's — `windowSeconds` is passed through unmodified so a
 * distributed implementation (Durable Object / Redis / Upstash — out of scope for this repo,
 * ADD-45 D-1) can apply whatever windowing it wants. `InMemoryRateLimitCounter` below documents
 * its own choice (fixed window).
 */
export interface RateLimitCounter {
  increment(key: string, windowSeconds: number): number | Promise<number>;
}

/**
 * Reference implementation for tests and single-process/dev deployments — NOT for production
 * multi-instance or edge deployments (see this file's header, and ADD-45 D-1): state is a plain
 * `Map` held in this object's memory, so it is per-instance. On a Workers/edge isolate
 * (`examples/demo/remote-mcp-worker`) a new isolate can spin up per request, silently resetting
 * every counter to zero — an in-process counter there is not a limit at all, it is a coin flip.
 * A production deployment supplies its own `RateLimitCounter` backed by a Durable Object, Redis,
 * Upstash, or similar shared store (ONBOARDING.md documents the seam).
 *
 * Fixed-window counting: time is sliced into non-overlapping `windowSeconds`-wide buckets
 * aligned to the epoch (`Math.floor(now / windowMs) * windowMs`), and `increment` returns the
 * running count for whichever bucket `now` currently falls in. A request that lands exactly on
 * a window boundary (`now === windowStart`) belongs to the NEW window, not the old one —
 * `Math.floor` puts the boundary instant itself in the bucket that starts there.
 */
export class InMemoryRateLimitCounter implements RateLimitCounter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();
  private readonly now: () => number;

  /** `now` is injectable so tests can move the clock deterministically across a window boundary
   *  without a real `setTimeout`/sleep — defaults to the real wall clock. */
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  increment(key: string, windowSeconds: number): number {
    const nowMs = this.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const existing = this.buckets.get(key);
    if (existing && existing.windowStart === windowStart) {
      existing.count += 1;
      return existing.count;
    }
    // Either the first request ever for this key, or the previous bucket has expired — a fresh
    // window starts at count 1. The stale bucket is simply overwritten (BR: no unbounded growth
    // per key — each key holds exactly one bucket at a time, never a history).
    this.buckets.set(key, { windowStart, count: 1 });
    return 1;
  }
}

/** #45 / ADD-45 D-2: the one new reason code this increment adds. Distinct from every code
 *  `evaluatePolicy` returns (BR-29's closed four) and from the two lifecycle codes — a client or
 *  auditor filtering on `"rate_limit_exceeded"` must see ONLY "the counter said no", never a
 *  principal/allow-list refusal wearing a rate-limit-shaped label. */
export type RateLimitDenialReason = "rate_limit_exceeded" | PolicyDenialReason;
export const RATE_LIMIT_EXCEEDED_REASON = "rate_limit_exceeded" satisfies RateLimitDenialReason;

export interface RateLimitDenial {
  reason: RateLimitDenialReason;
  /** Human-readable and agent-facing, same disclosure discipline as `PolicyDenial.message`
   *  (BR-30): no policy id, no other caller's identity, no raw counter value that would let a
   *  caller infer how many OTHER callers share its bucket. */
  message: string;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; denial: RateLimitDenial };

const ALLOWED: RateLimitDecision = { allowed: true };

function deny(reason: RateLimitDenialReason, message: string): RateLimitDecision {
  return { allowed: false, denial: { reason, message } };
}

/**
 * #45 / ADD-45 D-3, revised (bug fix found reviewing #45): key derivation is **per policy RULE
 * and per principal, when a principal is present; per rule ALONE when it is not.**
 * Deliberately NOT per capability — see below.
 *
 * Rationale, stated explicitly because the issue requires it to be (never left as undefined
 * behaviour): a rate limit exists to bound how much of a BACKEND's capacity one caller can
 * consume. `ruleId` is a policy document's `metadata.id`, which BR-4 guarantees is globally
 * unique across the whole manifest — so it alone is already enough to identify which declared
 * control governs a given attempt, without also folding in the capability being called.
 *
 * This matters because a `scope: provider` policy's rule is lowered (`lowerPolicyRules`,
 * `compile.ts`) onto EVERY capability under that provider, all carrying the SAME `rule.id`. That
 * is one control, meant to bound the provider's TOTAL capacity across every capability it backs
 * — not N independent controls that happen to share a number. Folding `capabilityId` into the
 * key (the original design) split that one shared budget into N independent ones, silently
 * multiplying a provider limit of 100/min into an effective N×100/min. Keying by `ruleId` alone
 * fixes that: a provider-scoped rule's bucket is now genuinely shared across every capability it
 * governs, while a capability-scoped rule's id is unique to that one capability by construction
 * (nothing else in the manifest ever resolves the same id onto another capability), so it stays
 * exactly as isolated as before.
 *
 * When the caller is anonymous there is no seam to distinguish one anonymous caller from another
 * (rate-limiting by IP/connection is explicitly out of scope for this increment — no such seam
 * exists on the invocation path today), so every anonymous caller sharing a rule shares ONE
 * bucket. That is a deliberately more conservative posture than "anonymous is unlimited": an
 * unauthenticated capability under load is throttled as a whole rather than not throttled at
 * all, which is the fail-closed-leaning choice consistent with ADD-42's "anonymous is not
 * denied, but never privileged" posture.
 */
function rateLimitKey(ruleId: string, principal: string | undefined): string {
  return `${ruleId}::${principal ?? "*anonymous*"}`;
}

/**
 * Evaluate every `rateLimit`-bearing resolved policy attached to `tool`, in the SAME evaluation
 * point `evaluatePolicy` occupies (called immediately after it, at the same two call sites) but
 * as its own async function — see this file's header for why it cannot be a branch inside
 * `evaluatePolicy` itself.
 *
 * #45 / ADD-45 D-2: the no-store default is **fail CLOSED**. A capability that declares
 * `rateLimit` and is invoked with no `counter` supplied is DENIED — `reason:
 * "policy_unevaluatable"`, deliberately the SAME code `evaluatePolicy` already returns for "a
 * rule this version cannot fully evaluate" (`policy.ts`'s `unevaluatable()`), not a new one: the
 * two situations are the identical fact ("a declared control cannot be evaluated right now, so
 * refuse rather than silently proceed unlimited") arrived at by two different routes, and this
 * increment's own motivating text ("an inert rate limit is a false control") is exactly BR-24's
 * reasoning already ratified for the pure evaluator. Reusing the code means a client or auditor
 * filtering on `policy_unevaluatable` sees every "this version could not evaluate a declared
 * control" case in one place, not split arbitrarily by which evaluator produced it.
 *
 * Called unconditionally cheaply: a tool with no `rateLimit`-bearing rule returns `ALLOWED`
 * before touching `counter` at all — a deployer who never uses `rateLimit` pays zero cost and
 * needs no counter.
 *
 * Bug fix (found reviewing #45): every `rateLimit`-bearing rule on a tool sees every attempt,
 * deterministically — NOT order-dependent. The original implementation was a `for` loop that
 * incremented one rule at a time and returned (denied) as soon as one rule's count exceeded its
 * max: rules AFTER the denying one were never touched for that call, while rules BEFORE it were
 * already incremented even though the call was ultimately denied. That made metering depend on
 * `tool.policyRules`'s array order rather than the manifest's declared semantics — a call denied
 * by a strict rule could fail to consume a looser/shared rule's budget purely because the looser
 * rule happened to be listed after the strict one. Now every governing rule is incremented via
 * `Promise.all` FIRST (so every rule genuinely observes every attempt, matching "these are all
 * independently-declared controls, all of which govern this call" — not "the first rule that
 * happens to deny short-circuits metering for the rest"), and only THEN is the exceeded check
 * applied. When more than one rule is exceeded, the FIRST one (by array order) is named in the
 * denial message — an arbitrary but deterministic tie-break, consistent with this file's
 * existing message conventions; the fail-closed "no counter supplied" check still runs once,
 * up front, before any rule's counter is touched (unchanged behaviour).
 */
export async function evaluateRateLimit(
  tool: IRTool,
  caller: { principal?: string },
  counter: RateLimitCounter | undefined,
): Promise<RateLimitDecision> {
  const rules = tool.policyRules?.filter((r) => r.rateLimit !== undefined);
  if (!rules || rules.length === 0) return ALLOWED;

  if (!counter) {
    return deny(
      "policy_unevaluatable",
      `capability '${tool.id}' declares spec.rateLimit but no RateLimitCounter was supplied — refusing (fail-closed); see ADD-45's no-store-default decision`,
    );
  }

  const counts = await Promise.all(
    rules.map((rule) => counter.increment(rateLimitKey(rule.id, caller.principal), rule.rateLimit!.windowSeconds)),
  );

  for (let i = 0; i < rules.length; i++) {
    const { maxInvocations, windowSeconds } = rules[i].rateLimit!;
    if (counts[i] > maxInvocations) {
      return deny(
        RATE_LIMIT_EXCEEDED_REASON,
        `capability '${tool.id}' exceeded its rate limit (${maxInvocations} per ${windowSeconds}s) for this caller.`,
      );
    }
  }

  return ALLOWED;
}
