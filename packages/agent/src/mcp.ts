// @archstone/agent/mcp — mountable Streamable-HTTP MCP surface (ADD-0008 #29)
//
// The ONLY place in @archstone/agent that reaches the MCP SDK — transitively, via
// @archstone/runtime's `/http` subpath (never its root, which carries the
// @archstone/schema/node:fs edge). A subpath EXPORT, not a method on the object fromIR()
// returns (ADD-0008's Architectural Challenge / R-1): a method would force every consumer's
// bundler to walk a static import edge to the SDK even when they only ever call
// tools()/execute(). The root entry (./index.ts, ./tools.ts, ./execute.ts) must never
// import this file or anything it imports — enforced by test/boundary.test.ts.

import { createHttpHandler, type CreateHttpHandlerOptions } from "@archstone/runtime/http";
import type { Archstone } from "./index";

/**
 * The invoke-context identity type `resolveCaller` returns (owned by `@archstone/provider-rest`,
 * ADD-32 D-1). Re-exported here so a consumer can *name* it when they factor `resolveCaller`
 * out of the options literal, without importing from `@archstone/provider-rest` — a transitive
 * dependency of this package, not a declared dependency of theirs (#46). Structural typing
 * already worked; being able to find the type is the defect this closes.
 */
export type { CallerContext } from "@archstone/provider-rest";

/**
 * Options for `mcpHandler`. **Invariant:** every field of `CreateHttpHandlerOptions` must be
 * represented here — `mcpHandler` forwards this object to `createHttpHandler` verbatim (see
 * below), so a field missing from this type is unreachable from *typed* code even though it
 * would work at runtime. That is exactly how `resolveCaller` went missing between #32 and #46.
 * `test/mcp.test.ts` pins the key-set parity at compile time so it cannot happen a third time.
 *
 * #46 also ruled on the escape hatch that omission left open, and the ruling is **legitimize,
 * not close**: TS2353 is an excess-property check and fires only on fresh object literals, so a
 * deployer could always pass `resolveCaller` by assigning it to a `CreateHttpHandlerOptions`-
 * typed variable first and handing *that* over — structurally assignable, clean compile, and
 * correct per-request behaviour, because the wrapper never inspects the object. Widening this
 * interface makes the honest spelling the typed one; it does not withdraw the laundered one.
 * Anything that narrows this type (an exact/branded options shape, `Omit`, a runtime key check)
 * would break deployers already on that path — `test/mcp.test.ts` pins its runtime behaviour.
 */
export interface McpHandlerOptions {
  /** Required shared secret gating access to the MCP protocol surface — who may reach
   *  `initialize`/`tools/list`/`tools/call` on this endpoint at all (ADD-0008 §5). Missing or
   *  empty throws at construction time, not on the first request (Rule #7 — core never ships
   *  open by default; R-5). Enforced by createHttpHandler itself; this wrapper does not
   *  relax, catch, or default it. */
  bearerToken: string;
  /** Forwarded to createHttpHandler for REST-provider calls (env/fetchImpl) — the same shape
   *  invokeRest already accepts (Workers-style env injection, never `process.env`).
   *
   *  **`caller` is the one key of this bag that does not survive the trip.** createHttpHandler
   *  rebuilds the per-request options as `{ ...invoke, caller: resolveCaller?.(request) }`
   *  (`runtime/src/http.ts:66`), so a `caller` set here is unconditionally overwritten — with
   *  `undefined` when no `resolveCaller` is supplied. On this surface, caller identity comes
   *  from `resolveCaller` below or from nowhere: setting `invoke.caller` here has no effect,
   *  and every `authenticated` capability then fails closed. (`serveStdio`'s `invoke.caller` is
   *  a different path and does work — one child process per conversation, so a static
   *  per-process caller is correct there and only there.) */
  invoke?: CreateHttpHandlerOptions["invoke"];
  /**
   * ADD-32: extracts the caller credential for ONE inbound request. `createHttpHandler` calls
   * it fresh inside its per-request closure (it already rebuilds an MCP server per request), so
   * two concurrent end users never share an identity — unlike `invoke.caller` above, which is
   * fixed when the handler is constructed. Archstone does not validate the token itself: this
   * is a seam for a host that has **already** authenticated its end user and is handing over
   * the resulting token. Archstone does not host an OIDC broker.
   *
   * Orthogonal to `bearerToken` (ADD-32 R-2) — restated here rather than linked, because this
   * is the surface where the two are most likely to be conflated:
   *   - `bearerToken` gates WHO may reach this MCP endpoint at all (endpoint access).
   *   - `resolveCaller` resolves WHOSE backend data a given, already-authorized call acts on.
   * They compose (set both); neither substitutes for the other. A request can be a validly
   * authorized MCP client (it passed `bearerToken`) and still supply no/invalid caller
   * credential, which then fails closed inside `invokeRest` for any `authenticated` capability.
   */
  resolveCaller?: CreateHttpHandlerOptions["resolveCaller"];
}

/**
 * A mountable, Web-standard `(Request) => Promise<Response>` MCP endpoint over an embedded
 * Archstone instance (fromIR()'s return value). Thin wrapper over
 * @archstone/runtime/http's createHttpHandler — reuses the instance's Registry, no
 * reimplementation of the transport, the bearer-token gate, the per-request caller resolution,
 * or the "no CORS by default" posture (ADD-0008 §5). `opts` is forwarded **verbatim**, which is
 * why `McpHandlerOptions` must stay key-for-key with `CreateHttpHandlerOptions` (see above).
 */
export function mcpHandler(
  archstone: Archstone,
  opts: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  return createHttpHandler(archstone.registry, opts);
}
