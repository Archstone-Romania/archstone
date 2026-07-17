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
import type { InvokeOptions } from "@archstone/provider-rest";
import { createMcpServer } from "./server";

export { createMcpServer } from "./server";

export interface CreateHttpHandlerOptions {
  /** Required shared secret gating access to the MCP protocol surface — who may reach
   *  `initialize`/`tools/list`/`tools/call` on this endpoint at all (ADD-0008 §5). Missing or
   *  empty throws at construction time, not on the first request (Rule #7 — core never ships
   *  open by default; R-5). */
  bearerToken: string;
  /** Forwarded to createMcpServer for REST-provider calls (env/fetchImpl). */
  invoke?: InvokeOptions;
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

    const server = createMcpServer(registry, opts.invoke);
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
