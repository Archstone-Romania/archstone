// @archstone/runtime — MCP emitter (#7) — stdio entrypoint
//
// serveStdio builds the registry from disk (buildRegistry, registry.ts) and serves it over
// stdio, the channel Claude Desktop uses. The fs-free MCP server construction
// (toolDefinitions/callTool/createMcpServer) lives in ./server (ADD-0008 #27) — re-exported
// here, alongside the semantic-lowering functions from @archstone/emitter-support, for
// back-compat so nothing downstream breaks.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRegistry } from "./registry";
import { toolDefinitions, createMcpServer } from "./server";

export { toolName, inputJsonSchema, objectJsonSchema } from "@archstone/emitter-support";
export * from "./server";

/** Build the registry from a manifest dir and serve it over stdio (blocks). */
export async function serveStdio(dir: string): Promise<void> {
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
  const server = createMcpServer(built.registry);
  await server.connect(new StdioServerTransport());
}
