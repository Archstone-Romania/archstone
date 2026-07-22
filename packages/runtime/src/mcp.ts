// @archstone/runtime — MCP emitter (#7) — stdio entrypoint
//
// serveStdio builds the registry from disk (buildRegistry, registry.ts) and serves it over
// stdio, the channel Claude Desktop uses. The fs-free MCP server construction
// (toolDefinitions/callTool/createMcpServer) lives in ./server (ADD-0008 #27) — re-exported
// here, alongside the semantic-lowering functions from @archstone/emitter-support, for
// back-compat so nothing downstream breaks.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { InvokeOptions } from "@archstone/provider-rest";
import { buildRegistry } from "./registry";
import { toolDefinitions, createMcpServer } from "./server";

export { toolName, inputJsonSchema, objectJsonSchema } from "@archstone/emitter-support";
export * from "./server";

/**
 * Build the registry from a manifest dir and serve it over stdio (blocks).
 *
 * `invoke` (ADD-32) is forwarded verbatim to `createMcpServer` — this closes a real gap: prior
 * to #32, `serveStdio` passed NO `InvokeOptions` at all, so nothing (not `env`, not `caller`)
 * could ever be injected here. A stdio server is one child process per conversation (Claude
 * Desktop's model) — single-process, single-user by construction — so a static per-process
 * `invoke.caller` is architecturally sound here, unlike the HTTP case (`createHttpHandler`'s
 * `resolveCaller`, which must vary per inbound request).
 */
export async function serveStdio(dir: string, invoke?: InvokeOptions): Promise<void> {
  const built = buildRegistry(dir);
  if (!built.ok || !built.registry) {
    // stdout is the MCP channel — all human output goes to stderr.
    console.error(`archstone: cannot serve '${dir}' — manifest invalid:`);
    for (const i of built.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of built.diagnostics.filter((x) => x.severity === "error")) console.error(`  - ${d.message}`);
    process.exit(1);
  }
  const tools = toolDefinitions(built.registry);
  console.error(`archstone: serving ${tools.length} tool(s) over stdio: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  const server = createMcpServer(built.registry, invoke);
  await server.connect(new StdioServerTransport());
}
