// @archstone/emitter-support — the policy evaluation point (#43 / ADD-43)
//
// THE one place Archstone answers "may this principal invoke this capability right now?".
// Called by all THREE invocation consumers — @archstone/runtime's `callTool`, @archstone/agent's
// `executeCapability`, and @archstone/runtime's `verifyTool` (ADD-43 D-6) — before any connector
// work, so the embedded SDK, the MCP surface and the contract prober cannot drift apart the way
// `tools()`/`execute()` did in #30.
//
// PURE by construction: no I/O, no clock, no counters, no cache, no fetch, no fs. That is what
// makes it work unchanged on a stateless edge runtime, and it is also what keeps `rateLimit`
// (which needs state) structurally outside this slice rather than merely out of scope (#45).
//
// The principal arrives as a bare `string | undefined` and NEVER as a `CallerContext`
// (ADD-42 D-5) — that is precisely what keeps this package free of a dependency on
// `@archstone/provider-rest`, i.e. what keeps the shared substrate from learning about HTTP.

import type { IRTool, IRPolicyRule } from "@archstone/compiler";

/**
 * The closed set of denial reasons (BR-29, founder-ratified AC OQ-E).
 *
 * Deliberately four, deliberately small: the moment a client or an auditor filters on one of
 * these strings it is permanent in the Rule #11 sense. #44's `Execution.status.denialReason` is
 * EXACTLY this set — same spellings, no superset, no free text (ADD-43 D-12), agreed before
 * either consumer shipped because reconciling two vocabularies afterwards is strictly more
 * expensive.
 *
 * Note what is deliberately NOT distinguished: `principal_not_allowed` covers both "you supplied
 * no principal" and "you supplied one that is not on the list". That is a **disclosure**
 * decision (BR-30, Rule #7), not a loss of fidelity — a denial that told the two apart would
 * turn the tool surface into an enumeration oracle, letting an attacker who can vary the
 * principal learn which identifiers are real one refused call at a time. Do not "improve" it.
 */
export type PolicyDenialReason =
  | "authenticated_no_credential"
  | "principal_not_allowed"
  | "principal_denied"
  | "policy_unevaluatable";

/**
 * What the evaluator knows about the caller. Two independent axes, never merged (ADD-42 D-3/D-7):
 *
 *  - `principal` — WHO is calling. Opaque, host-asserted, never parsed or normalized by
 *    Archstone, and only ever as trustworthy as the host's own authentication (ADD-42 D-1/D-9).
 *  - `credentialPresent` — whether a caller CREDENTIAL was supplied, i.e. the shipped predicate
 *    of the `authenticated` CDL token (`caller?.accessToken !== undefined`). Supplying a
 *    principal does not satisfy it, and this increment must not redefine it (ADD-42 D-7).
 *
 * Passed as a small structural object rather than a `CallerContext`: `credentialPresent` is
 * required, so a `CallerContext` is *not* assignable here — the type system rejects the shortcut
 * that would drag `providers/rest` into this package.
 */
export interface PolicyCaller {
  /** `undefined` = anonymous. Not an error in itself; it simply matches no `allow` entry. */
  principal?: string;
  /** `caller?.accessToken !== undefined` at the call site — nothing else. */
  credentialPresent: boolean;
}

export interface PolicyDenial {
  reason: PolicyDenialReason;
  /** Human-readable and agent-facing. Discloses no policy id and no allow/deny entry (BR-30). */
  message: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; denial: PolicyDenial };

/** The only keys `IRPolicyRule` defines (ADD-43 D-1, widened by ADD-45 D-1 to add `rateLimit`).
 *  Anything else on a rule means the artifact was hand-written or produced by a newer compiler,
 *  and is refused — see `unevaluatable`. */
const KNOWN_RULE_KEYS: ReadonlySet<string> = new Set(["id", "allow", "deny", "rateLimit"]);

const ALLOWED: PolicyDecision = { allowed: true };

function deny(reason: PolicyDenialReason, message: string): PolicyDecision {
  return { allowed: false, denial: { reason, message } };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Can this rule be fully evaluated by THIS version? Fail-closed defence in depth (BR-24).
 *
 * `archstone apply` already refuses everything that would land here (`rateLimit` and non-empty
 * `constraints` are authoring-time errors; an empty `constraints` is stripped at lowering), so
 * this branch is unreachable from a compiled manifest. It exists for the paths that bypass
 * `apply` entirely — a hand-written `archstone.ir.json`, or an artifact built by a future
 * compiler that lowers a key this version does not understand. A policy is NEVER partially
 * applied: "evaluate the allow and ignore the unknown key" is exactly the fail-open this rule
 * forbids.
 */
function unevaluatable(rule: IRPolicyRule): boolean {
  for (const key of Object.keys(rule)) {
    if (!KNOWN_RULE_KEYS.has(key)) return true;
  }
  if (typeof rule.id !== "string") return true;
  if (rule.allow !== undefined && !isStringArray(rule.allow)) return true;
  if (rule.deny !== undefined && !isStringArray(rule.deny)) return true;
  // #45 (ADD-45 D-1): a well-formed `rateLimit` is a KNOWN key, not an unevaluatable one — its
  // presence must never fail this pure evaluator closed. `evaluateRateLimit`
  // (`ratelimit.ts`) is the function that actually enforces it, at the same call sites,
  // immediately after this one allows. A malformed `rateLimit` (wrong types, or a shape
  // `archstone apply` would have refused — defence in depth for a hand-written/forward-versioned
  // artifact) DOES fail this rule closed, same as a malformed `allow`/`deny` above.
  if (rule.rateLimit !== undefined) {
    const rl = rule.rateLimit as { maxInvocations?: unknown; windowSeconds?: unknown };
    // Bug fix (found reviewing #45): matches the compiler's own `policy-ratelimit-invalid`
    // check (`validate.ts`) and `lowerPolicyRules` (`compile.ts`) — both require a positive
    // INTEGER, not merely `typeof === "number"`. A shape like `windowSeconds: 0` used to pass
    // this loose check and reach `InMemoryRateLimitCounter.increment`, where dividing by a
    // zero-length window produces `NaN`, and `NaN !== NaN` makes every call look like a fresh
    // window — the rate limit silently never triggers. Requiring integer >= 1 here closes that.
    if (
      typeof rl.maxInvocations !== "number" ||
      !Number.isInteger(rl.maxInvocations) ||
      rl.maxInvocations < 1 ||
      typeof rl.windowSeconds !== "number" ||
      !Number.isInteger(rl.windowSeconds) ||
      rl.windowSeconds < 1
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Decide whether one invocation of `tool` by `caller` is permitted.
 *
 * Called UNCONDITIONALLY on every invocation on every path, including for a capability with no
 * `policyRules` at all (ADD-43 D-5 / BR-18). This is load-bearing rather than tidy: gating the
 * call on `policyRules` being present would silently stop enforcing `authenticated` for every
 * capability that declares the token without a policy document — which is most of them today.
 *
 * Decision order is fixed and asserted (BR-15); deny always wins over allow:
 *   0. any rule this version cannot fully evaluate → `policy_unevaluatable`
 *   1. the `authenticated` token declared and no caller credential → `authenticated_no_credential`
 *   2. the principal matches any resolved `deny` entry → `principal_denied`
 *   3. any resolved policy carries a non-empty `allow` the principal does not satisfy →
 *      `principal_not_allowed`
 *   4. otherwise → allow
 *
 * Steps 2 and 3 together are ADD-43 D-13's composition rule: **union on `deny`, intersection on
 * `allow`** — any matching deny denies, and EVERY policy carrying a non-empty allow must be
 * satisfied. Intersection is the safe direction: union would let a capability-scoped policy
 * silently widen access beyond its provider-scoped baseline.
 *
 * Matching is exact, case-sensitive, byte-for-byte string equality — no wildcard, prefix, regex,
 * glob, trimming, case folding, or Unicode normalization (BR-9). The principal is opaque; an
 * ABSENT principal therefore matches nothing at all, including in `deny` (ADD-42 D-4). To permit
 * anonymous invocation, omit `allow`.
 */
export function evaluatePolicy(tool: IRTool, caller: PolicyCaller): PolicyDecision {
  const rules = tool.policyRules;

  // 0. Unevaluatable — first, so a satisfiable half of a rule can never carry the decision.
  //
  // `policies` is REQUIRED on `IRTool` and every artifact this compiler has ever emitted carries
  // it (`compile.ts` writes `c.policies ?? []`), so this branch is unreachable from `archstone
  // build`. It exists because `fromIR` accepts an artifact on `version === "0"` alone and treats
  // the rest as opaque — so a hand-written or corrupted one reaches this function, and a
  // decision point that THROWS on malformed input rather than denying is the wrong failure mode
  // for the one place authorization is decided. If the token list cannot be read, this version
  // cannot establish whether `authenticated` was declared; "cannot establish" must resolve to a
  // refusal, never to an exception and never to an implicit "no tokens".
  if (!Array.isArray(tool.policies) || !tool.policies.every((p) => typeof p === "string")) {
    return deny(
      "policy_unevaluatable",
      `capability '${tool.id}' carries a policy this version cannot evaluate — refusing (fail-closed).`,
    );
  }

  if (rules !== undefined) {
    if (!Array.isArray(rules)) {
      return deny(
        "policy_unevaluatable",
        `capability '${tool.id}' carries a policy this version cannot evaluate — refusing (fail-closed).`,
      );
    }
    for (const rule of rules) {
      if (!rule || typeof rule !== "object" || unevaluatable(rule)) {
        return deny(
          "policy_unevaluatable",
          `capability '${tool.id}' carries a policy this version cannot evaluate — refusing (fail-closed).`,
        );
      }
    }
  }

  // 1. The `authenticated` CDL token. Moved here out of `providers/rest` (ADD-43 D-4) — moved,
  // not copied, because two enforcement sites is precisely the "one answer to where a policy is
  // decided" this increment exists to establish. Predicate and message are preserved
  // byte-for-byte: five shipped test files assert this exact text.
  if (tool.policies.includes("authenticated") && !caller.credentialPresent) {
    return deny(
      "authenticated_no_credential",
      `capability '${tool.id}' requires policies:[authenticated] — no caller credential (accessToken) provided on invoke`,
    );
  }

  if (rules === undefined || rules.length === 0) return ALLOWED;

  const { principal } = caller;

  // 2. Deny wins, across the whole resolved set — never first-match.
  for (const rule of rules) {
    if (principal !== undefined && rule.deny?.includes(principal)) {
      return deny(
        "principal_denied",
        `capability '${tool.id}' is not permitted for this caller by policy.`,
      );
    }
  }

  // 3. Every non-empty `allow` must be satisfied (intersection). An absent principal satisfies
  // none of them — which is how "this capability must not be invoked anonymously" is expressed.
  for (const rule of rules) {
    const allow = rule.allow;
    if (allow === undefined || allow.length === 0) continue;
    if (principal === undefined || !allow.includes(principal)) {
      return deny(
        "principal_not_allowed",
        `capability '${tool.id}' is not permitted for this caller by policy.`,
      );
    }
  }

  return ALLOWED;
}
