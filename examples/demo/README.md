# Demo — Wanderlust Travel in Claude, with zero manual integration

The whole integration is [12 lines of CDL](../manifests/tourism/tourism.search.capability.yaml). No MCP server was hand-written, no HTTP glue. `archstone` compiles it and serves it as an MCP tool Claude can call.

## What you'll show (≈3 minutes)

1. **The manifest** — [`manifests/tourism/`](../manifests/tourism/): a `capabilities.yaml` + one `tourism.search` capability + its REST binding. Business only.
2. **Compile & inspect:**
   ```bash
   pnpm apply examples/manifests/tourism
   ```
   → `shapes valid · semantic 0 errors · registry IR v0 — 1 capabilities, 1 invocable`.
3. **Start the backend** (a real sandbox in production; a mock here):
   ```bash
   pnpm demo:mock          # mock stays API on http://localhost:8787
   ```
4. **Serve it to Claude** — see the config below, restart Claude Desktop.
5. **Ask Claude:** *"Family of 4, beach, first week of July, under €2000 — find us a place to stay."*
   Claude discovers `tourism_search`, calls it, and the backend returns real availability.
6. **Punchline:** *"No integration code was written. Just 12 lines of CDL."*

## Claude Desktop config

Add this to your `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), replacing `<REPO>` with the absolute path to this repository:

```json
{
  "mcpServers": {
    "archstone-wanderlust": {
      "command": "<REPO>/node_modules/.bin/tsx",
      "args": [
        "<REPO>/packages/cli/src/index.ts",
        "serve",
        "<REPO>/examples/manifests/tourism"
      ],
      "env": { "STAYS_API_URL": "http://localhost:8787" }
    }
  }
}
```

Restart Claude Desktop. The `tourism_search` tool appears; ask a travel question and it invokes the backend.

> Point `STAYS_API_URL` at a real booking sandbox to run against live availability — the CDL and the generated tool do not change. That is the whole thesis: swap the backend, not the integration.

## Verified automatically

The full path (MCP call → provider → HTTP backend → response) is covered by
[`packages/runtime/test/demo.integration.test.ts`](../../packages/runtime/test/demo.integration.test.ts):
it starts a mock backend, spawns `archstone serve`, and drives it with a real MCP client.
