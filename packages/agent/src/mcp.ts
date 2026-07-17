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

export interface McpHandlerOptions {
  /** Required shared secret gating access to the MCP protocol surface — who may reach
   *  `initialize`/`tools/list`/`tools/call` on this endpoint at all (ADD-0008 §5). Missing or
   *  empty throws at construction time, not on the first request (Rule #7 — core never ships
   *  open by default; R-5). Enforced by createHttpHandler itself; this wrapper does not
   *  relax, catch, or default it. */
  bearerToken: string;
  /** Forwarded to createHttpHandler for REST-provider calls (env/fetchImpl) — the same shape
   *  invokeRest already accepts (Workers-style env injection, never `process.env`). */
  invoke?: CreateHttpHandlerOptions["invoke"];
}

/**
 * A mountable, Web-standard `(Request) => Promise<Response>` MCP endpoint over an embedded
 * Archstone instance (fromIR()'s return value). Thin wrapper over
 * @archstone/runtime/http's createHttpHandler — reuses the instance's Registry, no
 * reimplementation of the transport, the bearer-token gate, or the "no CORS by default"
 * posture (ADD-0008 §5).
 */
export function mcpHandler(
  archstone: Archstone,
  opts: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  return createHttpHandler(archstone.registry, opts);
}
