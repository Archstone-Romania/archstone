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

/**
 * The store a distributed `SharedWindowRateLimitCounter` writes through. Deliberately ONE
 * method, and deliberately the exact shape Redis's `INCR` + `EXPIRE` pair already has, because
 * that is the shape almost every shared store can honour: **atomically increment the integer at
 * `key`, ensure it expires in at most `ttlSeconds`, and return the value after the increment.**
 *
 * The atomicity requirement is not decorative. Two instances incrementing the same key
 * concurrently must observe two different return values, or the limit silently becomes
 * "N per window per instance" — which is exactly the defect `InMemoryRateLimitCounter` has by
 * construction, moved to a shared store and made harder to see. A read-modify-write over an
 * eventually-consistent KV (Cloudflare KV, S3) does **not** satisfy this; a Redis-compatible
 * store, a Cloudflare Durable Object, or a single SQL row updated with `RETURNING` does.
 */
export interface SharedCounterStore {
  incrementWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * A `RateLimitCounter` for multi-instance and edge deployments — the production counterpart to
 * `InMemoryRateLimitCounter`, which is per-process and therefore not a limit at all once more
 * than one process serves traffic.
 *
 * Windowing is **fixed**, identical to `InMemoryRateLimitCounter`'s and for the same reason
 * (the interface leaves it to the implementation, and two shipped implementations that disagree
 * about what a window is would be a trap): time is sliced into non-overlapping
 * `windowSeconds`-wide buckets aligned to the epoch, and the bucket start is folded into the
 * store key. The counter therefore never has to read, compare or reset anything — a new window
 * is simply a new key, which is why a store only needs `INCR`-with-TTL and never a transaction.
 *
 * TTL is `windowSeconds` plus a small grace, so a key outlives its own window slightly rather
 * than expiring underneath a request that is still being counted, and no key survives longer
 * than it can be useful. Nothing depends on the grace value for correctness — a key that
 * expires early can only ever undercount toward zero, never over the limit.
 *
 * **Clock skew across instances is real and bounded here.** Two instances whose clocks differ
 * by less than one window agree on the bucket for all but the instants near a boundary; at the
 * boundary a request may land in the neighbouring bucket. That is the standard fixed-window
 * trade and it is stated rather than hidden: a limit of N per window admits up to 2N across an
 * unlucky boundary pair. Deployments that cannot accept that need a sliding-window store
 * implementation, which this interface permits (the store may key however it likes) but this
 * class does not attempt.
 */
export class SharedWindowRateLimitCounter implements RateLimitCounter {
  private readonly store: SharedCounterStore;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly graceSeconds: number;

  constructor(
    store: SharedCounterStore,
    opts: {
      /** Injectable for deterministic tests, exactly as `InMemoryRateLimitCounter` does. */
      now?: () => number;
      /** Namespace for the store keys, so one Redis/DO can serve several deployments. */
      prefix?: string;
      /** Extra seconds of key lifetime beyond the window. Correctness does not depend on it. */
      graceSeconds?: number;
    } = {},
  ) {
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
    this.prefix = opts.prefix ?? "archstone:rl";
    this.graceSeconds = opts.graceSeconds ?? 5;
  }

  async increment(key: string, windowSeconds: number): Promise<number> {
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(this.now() / windowMs) * windowMs;
    return this.store.incrementWithTtl(
      `${this.prefix}:${key}:${windowStart}`,
      windowSeconds + this.graceSeconds,
    );
  }
}

/**
 * Adapter for any Redis-compatible client — `ioredis`, `node-redis`, Upstash's REST client —
 * **duck-typed on purpose**: this package takes no dependency on any of them, and the deployer
 * passes the client they already have. The two methods used are the two every one of them
 * exposes.
 *
 * `incr` then `expire` is two round-trips and is NOT a transaction. That is safe here for one
 * specific reason worth stating: `incr` alone is the atomic part that decides the returned
 * count, and `expire` only bounds the key's lifetime. A crash between them leaves a key with no
 * TTL — it keeps counting for that window and is superseded by the next window's key, so the
 * failure mode is a leaked key, never a missed limit. Deployers who mind the leak can pass a
 * client whose `incr` is a Lua script or pipeline instead; the interface does not care.
 */
export function redisSharedCounterStore(client: {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}): SharedCounterStore {
  return {
    async incrementWithTtl(key, ttlSeconds) {
      const count = await client.incr(key);
      // Only the first increment in a window needs the TTL set; setting it every time would
      // slide the expiry forward and keep a hot key alive indefinitely across windows.
      if (count === 1) await client.expire(key, ttlSeconds);
      return count;
    },
  };
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

  // A counter backed by a shared store performs I/O, and I/O fails. Before
  // `SharedWindowRateLimitCounter` shipped, the only counter in the tree was an in-process Map
  // that cannot reject, so a throwing counter was theoretical and this call was unguarded — a
  // rejection would have escaped `evaluateRateLimit` as an exception, through `callTool` and
  // `executeCapability`, both of which have no try/catch around this step. That is the #48
  // defect class exactly (a throwing `resolveCaller` escaping instead of denying), and shipping
  // a network-backed counter is what turns it from theoretical into the normal Tuesday of any
  // multi-instance deployment.
  //
  // A store that cannot answer is the same fact as no store at all: a declared control that
  // cannot be evaluated right now. Same `policy_unevaluatable` code, same fail-closed posture,
  // for the same reason ADD-45 D-2 already gives — an inert rate limit is a false control. The
  // underlying error text is deliberately NOT surfaced to the caller (BR-30 disclosure
  // discipline: an agent must not learn our store topology from a denial message); the audit
  // record at the call site carries the denial, and the deployer's own store client logs the
  // cause.
  let counts: number[];
  try {
    counts = await Promise.all(
      rules.map((rule) => counter.increment(rateLimitKey(rule.id, caller.principal), rule.rateLimit!.windowSeconds)),
    );
  } catch {
    return deny(
      "policy_unevaluatable",
      `capability '${tool.id}' declares spec.rateLimit but its RateLimitCounter could not be consulted — refusing (fail-closed)`,
    );
  }

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
