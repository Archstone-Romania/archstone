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
  /** Forwarded to createMcpServer for REST-provider calls (env/fetchImpl).
   *
   *  **`caller` set here is ignored, not a default.** The per-request rebuild below
   *  (`:66`) is `{ ...opts.invoke, caller: opts.resolveCaller?.(request) }` — `caller` is
   *  unconditionally overwritten on every request, with `undefined` when no `resolveCaller`
   *  is supplied. Per-request identity requires `resolveCaller` below; a static `caller` set
   *  here never reaches the backend. This differs from `serveStdio` (`runtime/src/mcp.ts:38`),
   *  where `invoke` — including `caller` — is forwarded verbatim to `createMcpServer` with no
   *  such rebuild, so a static `caller` there is correct by design (one child process per
   *  conversation). Do not "fix" this by making the rebuild below merge-if-absent — that would
   *  convert a loud fail-closed outage into a silent wrong-principal authorization (ADD-42
   *  D-13).
   *
   *  #44, and read this before setting a correlation id here: the per-request rebuild below
   *  overwrites exactly ONE key, `caller`. Everything else — including `auditSink`,
   *  `sessionId` and `workflowId` — survives the spread. That is what makes an audit sink set
   *  here work at all, and it is also the trap: a `sessionId` set here silently stamps every
   *  concurrent request with the same session, where a `caller` set here fails loudly instead.
   *  There is no per-request correlation seam on this surface today. */
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
    //
    // #48: `resolveCaller` is a host callback (a JWT parse, a session-store lookup) and is
    // unspecified for the throwing case — there is no `try`/`catch` anywhere else in this file.
    // A throw must NOT escape as a rejection (that would surface as an opaque 5xx to the MCP
    // client, or worse — see #49 on the CLI adapter this handler is mounted behind); it also
    // must not be silently treated as "no caller" (`undefined`), because a resolver that blew up
    // is strictly less trustworthy than one that deliberately returned nothing (ADD-42 R-11).
    // Caught here, once, and turned into `callerResolutionFailed`, which `callTool` (ADD-43's
    // one policy evaluation point) turns into a `policy_unevaluatable` denial — the SAME
    // structured, fail-closed shape every other unevaluatable-policy case already produces, not
    // a parallel one invented for this seam. `resolveCaller` stays synchronous per ADD-42 D-1;
    // this only contains what it might throw, it does not await it.
    let caller: InvokeOptions["caller"];
    let callerResolutionFailed: true | undefined;
    try {
      caller = opts.resolveCaller?.(request);
    } catch (err) {
      // Visible, not silently swallowed (a decision input failing is worse to hide than #39's
      // onResponse observation hook, which is why that one gets to log-and-continue) — same
      // "stdout is the MCP channel, human output goes to stderr" convention, logged once.
      console.error("archstone: resolveCaller threw — denying fail-closed:", err);
      callerResolutionFailed = true;
    }
    // Still exactly one overwritten key on the happy path (`caller`, per this option bag's own
    // doc comment above `resolveCaller`): `callerResolutionFailed` is only ever present here at
    // all when the resolver actually threw, so `opts.invoke.callerResolutionFailed` (there is no
    // legitimate reason a host would set it) is never masked on a normal request.
    const invoke: InvokeOptions = {
      ...opts.invoke,
      caller,
      ...(callerResolutionFailed ? { callerResolutionFailed } : {}),
    };
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
