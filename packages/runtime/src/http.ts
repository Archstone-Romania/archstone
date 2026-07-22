// @archstone/runtime/http — Web-standard Streamable-HTTP transport (ADD-0008 #27)
//
// createMcpServer (fs-free, from ./server) + createHttpHandler, the one Streamable-HTTP
// implementation D-3 asks for — shared by `archstone serve --http` and
// @archstone/agent's `mcpHandler()` (both #29). Nothing reachable from this module imports
// registry.ts's buildRegistry/@archstone/schema `load()` (the fs edge) or node:fs/node:path —
// a consumer depending on this subpath alone stays fs-free without relying on a bundler's
// nodejs_compat-style flag.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Registry } from "@archstone/emitter-support";
import type { CallerContext, InvokeOptions } from "@archstone/provider-rest";
import { createMcpServer } from "./server";

export { createMcpServer } from "./server";

export interface CreateHttpHandlerOptions {
  /** Required shared secret gating access to the MCP protocol surface — who may reach
   *  `initialize`/`tools/list`/`tools/call` on this endpoint at all (ADD-0008 §5). Missing or
   *  empty throws at construction time, not on the first request (Rule #7 — core never ships
   *  open by default; R-5). */
  bearerToken: string;
  /** Forwarded to createMcpServer for REST-provider calls (env/fetchImpl). A `caller` set here
   *  is a static, process-wide default — see `resolveCaller` below for the per-request case. */
  invoke?: InvokeOptions;
  /**
   * ADD-32: extracts the caller credential for ONE inbound request. Called inside the
   * per-request handler closure (a fresh MCP server is already built per request here, so
   * this varies per call, unlike `invoke.caller` above which is fixed at construction time).
   * Archstone does not validate the token itself — this is a seam for a host that has
   * *already* authenticated its end user and is handing over the resulting token; Archstone
   * does not host an OIDC broker.
   *
   * Orthogonal to `bearerToken` (R-2) — do not conflate the two:
   *   - `bearerToken` gates WHO may reach this MCP endpoint at all (endpoint access).
   *   - `resolveCaller` resolves WHOSE backend data a given, already-authorized call acts on.
   * They compose (both may be set); neither substitutes for the other. A request can be a
   * validly-authorized MCP client (passed `bearerToken`) yet still supply no/invalid caller
   * credential, which then fails closed inside `invokeRest` for any `authenticated` capability.
   */
  resolveCaller?: (request: Request) => CallerContext | undefined;
}

/**
 * A mountable, Web-standard `(Request) => Promise<Response>` MCP endpoint, bearer-token
 * gated. A missing or wrong `Authorization: Bearer` header gets a bare 401 — no tool
 * information in the body. No CORS headers are set: intended callers (Claude API
 * `mcp_servers`, ChatGPT connectors) are server-to-server, not browser `fetch` (ADD-0008 §5).
 */
export function createHttpHandler(
  registry: Registry,
  opts: CreateHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  if (!opts.bearerToken) {
    throw new Error("createHttpHandler: bearerToken is required and must be non-empty");
  }
  const expected = `Bearer ${opts.bearerToken}`;

  return async (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== expected) {
      return new Response(null, { status: 401 });
    }

    // Per-request InvokeOptions: opts.invoke's env/fetchImpl carry over unchanged; `caller` is
    // resolved fresh for THIS request via resolveCaller (ADD-32) — never cached across requests.
    const invoke: InvokeOptions = { ...opts.invoke, caller: opts.resolveCaller?.(request) };
    const server = createMcpServer(registry, invoke);
    // Stateless: no sessionIdGenerator, no per-caller session/state at all. JSON responses
    // (not SSE) — a freshly-built server per request has nothing to stream anyway.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
