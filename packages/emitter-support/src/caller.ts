// @archstone/emitter-support — the shared, connector-agnostic invoke-context shape
// (ADR-0012 D-3).
//
// `CallerContext` and the connector-agnostic half of `InvokeOptions` used to live in
// `providers/rest` (internal ADD-32 D-2 explicitly deferred this move to "the first
// non-REST connector" — this is that connector). Every field here is meaningful to MORE than
// one connector, or to the dispatch layer that sits above all of them (`invokeConnector`,
// `@archstone/emitter-support/connector`) — nothing REST-specific lives in this file.
// `providers/rest`'s own `InvokeOptions` extends `InvokeOptions` below, adding only what is
// genuinely REST-specific (`allowedHosts`, `onResponse`); `providers/sql` does the same,
// adding only `identityAdapter`'s partner mechanics it alone reads.

import type { AuditSink } from "./audit";
import type { RateLimitCounter } from "./ratelimit";

/**
 * A fact about ONE invocation — never about the compiled artifact (ADD-32 D-1). The IR is
 * reused across many invocations by many different end users; a caller credential lives only
 * in invoke-context types, never in `IRTool`/`IR`.
 */
export interface CallerContext {
  /** The end user's bearer token, supplied by a host that has already authenticated them
   *  (Archstone does not host an OIDC broker). Undefined means "no caller supplied" — a
   *  fail-closed gate distinguishes that from an explicit `""`, which is treated as present
   *  (ADD-32 §3/R-6). */
  accessToken?: string;
  /** Reserved for `tenant-scoped` policy enforcement — NOT enforced yet (a separate axis from
   *  identity/isolation). Nothing reads this field. */
  tenantId?: string;
  /**
   * WHO this invocation acts on behalf of — the caller's identity, as opposed to `accessToken`,
   * which is a credential to act WITH (ADD-42 D-2/D-3).
   *
   * **Asserted by the host, never verified by Archstone.** Archstone does not parse, decode,
   * split, normalize, or validate this value at any entry point (ADD-42 D-1) — it is an opaque,
   * deployer-chosen string.
   *
   * Absent means ANONYMOUS, not denied (ADD-42 D-4). Usable in `${caller.NAME}` REST
   * interpolation (ADD-32/42), and — for a `sql`-bound capability — this is the ONLY value
   * `identityAdapter` below ever receives (ADR-0012 D-3): a capability input field, even one
   * literally named `tenantId`, has no bearing on session identity.
   */
  principal?: string;
}

export type FetchLike = typeof globalThis.fetch;

/**
 * ADR-0012 D-3 — maps the resolved caller `principal` to session identity claims (e.g.
 * `{ tenantId: "acme" }`), read by `invokeSql` to set transaction-scoped `set_config` GUCs
 * before the declared query executes (D-4).
 *
 * A PURE function of the already-resolved principal, set ONCE, statically, at deployer
 * construction time (`ExecuteOptions`, `serveStdio`'s `invoke`, `createHttpHandler`'s
 * options) — unlike `resolveCaller` (ADD-32/42), which has to be per-request because it reads
 * the raw inbound `Request`. Never a per-request extraction hook, and read in exactly one
 * place: `invokeSql`.
 *
 * `undefined` — an unset adapter, or one that cannot resolve this principal — is a fail-closed
 * refusal (D-3): a `sql`-bound invocation with no resolved identity claims never proceeds to a
 * connection. There is no "run with no session identity" path.
 */
export type IdentityAdapter = (principal: string | undefined) => Record<string, string> | undefined;

/**
 * The shared, connector-agnostic half of a per-invocation options bag (ADR-0012 D-3). Every
 * connector's own `InvokeOptions` (`providers/rest`, `providers/sql`) extends this — nothing
 * here is REST- or SQL-specific; the invocation-agnostic caller-context wiring lives once.
 */
export interface InvokeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** ADD-32/42: the end user this specific invocation acts on behalf of. */
  caller?: CallerContext;
  /** #44/ADD-44: the `Execution` audit sink — one record per invocation ATTEMPT. Read only by
   *  the two AUDITED CONSUMERS (`callTool`, `executeCapability`), never by a connector. */
  auditSink?: AuditSink;
  /** #44: correlation ids, passed through to the audit record exactly as the host supplied
   *  them — never synthesized, defaulted, or derived, and never read by a connector. */
  sessionId?: string;
  workflowId?: string;
  /** #48: set by `@archstone/runtime`'s `createHttpHandler` for ONE request, when that
   *  request's `resolveCaller` (ADD-32) threw instead of returning. Never read by a connector —
   *  it rides this bag so the one caller that needs it (`callTool`) can see it. */
  callerResolutionFailed?: boolean;
  /** #45/ADD-45: TYPE-ONLY here, exactly like `auditSink` — no connector reads, calls, or
   *  branches on this field. */
  rateLimitCounter?: RateLimitCounter;
  /** ADR-0012 D-3 — see `IdentityAdapter`'s own doc comment. Read in exactly one place:
   *  `invokeSql` (`providers/sql`). Every other connector ignores it. */
  identityAdapter?: IdentityAdapter;
  /**
   * ADR-0012 D-4 — the literal prefix `invokeSql` prepends to each `identityAdapter`-returned
   * claim key when calling `set_config` (default `"app."`, so a `{ tenantId: "acme" }` claim
   * becomes the GUC `app.tenantId`). Deployer configuration, never CDL/binding content — a
   * manifest author cannot see it, let alone change it, from any CDL or binding file. Read
   * only by `invokeSql`; every other connector ignores it.
   */
  sqlSessionGucPrefix?: string;
}
