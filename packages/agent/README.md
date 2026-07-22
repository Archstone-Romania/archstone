# @archstone/agent

Embedded agent SDK (RFC-0008 / ADD-0008): load a compiled Archstone IR artifact, generate typed
tool definitions (Anthropic · OpenAI · Gemini · JSON-Schema), and invoke capabilities with
fail-closed response mapping — all without running a separate MCP server process.

**Two entry points:**

- **Root** (`@archstone/agent`): `fromIR(json)` constructs an embedded instance; `tools(format)`
  generates typed tool defs; `execute(capabilityId, input)` invokes a capability with mapping
  applied. Zero MCP SDK, zero `node:fs` — safe to bundle and run anywhere (browser, Worker,
  native app).
- **`/mcp` subpath** (`@archstone/agent/mcp`): `mcpHandler(archstone, {bearerToken})` — a
  mountable, fail-closed Streamable-HTTP MCP endpoint for consumers who want to expose an
  embedded instance as an MCP server (e.g., Claude API `mcp_servers`, ChatGPT connectors).

## Quick start

```typescript
import { fromIR, tools, execute } from "@archstone/agent";

// Load a compiled IR (produced by `archstone build manifest/`)
const ir = JSON.parse(fs.readFileSync("archstone.ir.json", "utf-8"));
const archstone = fromIR(ir);

// Get tool definitions in your preferred format
const anthropicTools = archstone.tools("anthropic");
const openaiTools = archstone.tools("openai");
const geminiTools = archstone.tools("gemini");

// Invoke a capability — accepts both raw dotted id or sanitized tool name
const result = await archstone.execute("tourism.search", {
  location: "Paris",
  checkInDate: "2026-08-01",
});
// Same call with sanitized tool name (as returned by tools()):
// const result = await archstone.execute("tourism_search", {...});

if (result.status === "ok") {
  console.log("Success:", result.data);
} else if (result.status === "degraded") {
  console.log("Partial:", result.data, "Missing:", result.degraded);
} else if (result.status === "violation") {
  console.log("Contract violation:", result.missing);
} else {
  console.log("Error:", result.error);
}
```

**For HTTP-based MCP:**

```typescript
import { mcpHandler } from "@archstone/agent/mcp";

const handler = mcpHandler(archstone, {
  bearerToken: process.env.ARCHSTONE_TOKEN,
  invoke: { env: process.env }, // optional: env injection for REST connectors
});

// Mount on your framework (e.g., Hono, Express, fetch-based)
const response = await handler(new Request(...));
```

Part of [Archstone](https://github.com/Archstone-Romania/archstone), an open-source
Capability Platform. For full documentation, see [`archstone/packages/agent`](../) and the
main [`README.md`](../../README.md).

## License

Apache-2.0
