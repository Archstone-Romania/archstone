// Growth/demo-only infra — see README.md. Hosts the already-compiled `tourism.search`
// example over a remote MCP endpoint so an archstone-website visitor's own Claude can call
// it with zero local install. One fixed, read-only, unauthenticated public tool — never a
// general hosted-compiler service. Not a Phase-2 product decision.
import { Registry, createMcpServer } from "@archstone/runtime";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IR } from "@archstone/compiler";
import ir from "./ir.generated.json";
import { mockStaysResponse } from "./mock-backend";

const registry = new Registry(ir as IR);

// Cloudflare blocks a Worker's fetch() from looping back to its own zone/route (error 1042) —
// confirmed against the deployed Worker, not just a theoretical concern. The REST connector's
// STAYS_API_URL points at this same Worker's own origin, so route that one case in-process
// instead of over the network: identical @archstone/provider-rest semantics (env resolution,
// path/body building), just no real HTTP hop for a backend that lives in this same script
// anyway. Any other destination still goes over a real fetch.
const loopbackAwareFetch: typeof fetch = async (input, init) => {
  const req = new Request(input as string | URL, init);
  if (new URL(req.url).pathname === "/v1/search") return mockStaysResponse(req);
  return fetch(req);
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The mock backend the tourism.search binding calls. Path matches
    // bindings/tourism.search.binding.yaml's `rest.path`. Kept as a real route (not just the
    // in-process shortcut above) so the backend shape is independently inspectable/curl-able.
    if (url.pathname === "/v1/search" && request.method === "POST") {
      return mockStaysResponse(request);
    }

    if (url.pathname === "/mcp") {
      // Resolve STAYS_API_URL per-request to this Worker's own origin — no deployment-time
      // config needed, and it survives moving between workers.dev and the custom domain.
      const server = createMcpServer(registry, {
        env: { STAYS_API_URL: url.origin },
        fetchImpl: loopbackAwareFetch,
      });
      // Stateless: no sessionIdGenerator, no per-visitor session/state at all. JSON responses
      // (not SSE) — a freshly-built server per request has nothing to stream anyway.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("archstone demo: not found", { status: 404 });
  },
};
