// Deploy template — your compiled capabilities, served as a remote MCP endpoint.
//
// Copy this directory, drop your own `archstone.ir.json` next to this file, and deploy. The
// whole Worker is the ~20 lines below because the work already happened at compile time:
// `archstone build` produced a portable artifact, and `mcpHandler` is a Web-standard
// `(Request) => Promise<Response>`, which is exactly a Worker's fetch handler.
//
// This is NOT `examples/demo/remote-mcp-worker`. That one hosts a fixed read-only demo with no
// auth on purpose; copying it for real capabilities would put an unauthenticated endpoint in
// front of your backend. This template is the authenticated path instead — see the token note
// below.

import { fromIR } from "@archstone/agent";
import { mcpHandler } from "@archstone/agent/mcp";
import type { IR } from "@archstone/compiler";
import ir from "./archstone.ir.json";

interface Env {
  /** Required. Gates who may reach this endpoint at all. See README — never ship without it. */
  ARCHSTONE_HTTP_TOKEN?: string;
  /** Everything your bindings reference as `${NAME}` — base URLs, API keys. Add them as
   *  Worker secrets (`wrangler secret put NAME`), not as plaintext vars. */
  [key: string]: string | undefined;
}

// Built once per isolate, not per request: `fromIR` validates the artifact and indexes it, and
// nothing about that depends on the request. It throws on a malformed or wrong-version
// artifact, which surfaces at deploy/first-hit rather than silently serving an empty tool list.
const archstone = fromIR(ir as IR);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Rule #7 — core never ships open by default. `mcpHandler` itself refuses to construct
    // without a token, but failing here first turns a misconfigured deploy into one clear 500
    // instead of an exception per request.
    if (!env.ARCHSTONE_HTTP_TOKEN) {
      console.error("ARCHSTONE_HTTP_TOKEN is not set — refusing to serve. See README.");
      return new Response("server misconfigured", { status: 500 });
    }

    // Built per request because `env` only exists inside `fetch` in the Workers module format.
    // It is a closure over an already-indexed registry, so this costs nothing measurable.
    const handler = mcpHandler(archstone, {
      bearerToken: env.ARCHSTONE_HTTP_TOKEN,
      // Your bindings' `${NAME}` placeholders resolve from here.
      invoke: { env },

      // Acting on behalf of a specific end user? Add `resolveCaller` and return their
      // credential per request:
      //
      //   resolveCaller: (req) => ({ accessToken: req.headers.get("x-end-user-token") ?? undefined }),
      //
      // Note `invoke: { caller }` does NOT work on this path — the per-request rebuild
      // overwrites it, deliberately, so a static caller can never be silently applied to
      // everyone's traffic. `resolveCaller` is the only way to set it here.
    });

    return handler(request);
  },
};
