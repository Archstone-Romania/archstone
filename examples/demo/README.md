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

## What Claude sees

`archstone serve` emits one MCP tool, `tourism_search`, with a typed `outputSchema` lowered
from the `tourism.Stay` resource ([`tourism.Stay.resource.yaml`](../manifests/tourism/tourism.Stay.resource.yaml)) — not a generic `object`/`array`:

```jsonc
// outputSchema.properties.stays.items.properties (abridged)
{
  "name":          { "type": "string", "description": "The property's display name." },
  "location":      { "type": "string", "description": "A place — city, region, or address." },
  "pricePerNight": { "type": "number", "description": "Nightly rate for the stay." },
  "rating":        { "type": "number", "description": "Guest review score, when available." }
}
// required: ["name", "location", "pricePerNight"] — "rating" is optional
```

That's why Claude can answer "is there a beach nearby?" from the declared shape alone, before
calling the tool. At invocation, the binding's `response:` block
([`tourism.search.binding.yaml`](../manifests/tourism/bindings/tourism.search.binding.yaml))
maps the mock backend's JSON onto exactly those fields and enforces the three required ones —
drop `pricePerNight` from the mock response and the tool call fails closed with a structured
"contract violation" error instead of handing Claude a malformed `Stay`.

> Note the `location` field's schema description is the semantic type's generic one ("A place
> — city, region, or address."), not the resource's own wording — the emitter currently
> prefers the built-in description over an authored one for semantic types that ship their
> own (`location`, `date-range`, `party`, `money`, `date`, `datetime`/`time-slot`, `enum`).

Before demoing, `pnpm verify examples/manifests/tourism` (against the mock backend running on
`:8787`) replays [`fixtures/tourism.search.golden.json`](../manifests/tourism/fixtures/tourism.search.golden.json) live and confirms the binding is still 🟢 — a quick sanity check that the mock hasn't drifted since the fixture was recorded.

## Verified automatically

The full path (MCP call → provider → HTTP backend → response) is covered by
[`packages/runtime/test/demo.integration.test.ts`](../../packages/runtime/test/demo.integration.test.ts):
it starts a mock backend, spawns `archstone serve`, and drives it with a real MCP client.
