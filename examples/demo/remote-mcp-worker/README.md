# Remote MCP demo Worker — growth/demo infra, not a product feature

This hosts the **already-existing, already-compiled, read-only** [`tourism.search`
example](../../manifests/tourism/) over a remote MCP endpoint (Streamable HTTP), so a visitor
on the marketing site (`archstone-website`) can add one entry to their own Claude config and
call a real Archstone-compiled tool — no local install, no `git clone`.

## What this is *not*

**This is not Phase 2.** The Archstone roadmap (MVP scope, decision D-21) explicitly defers
"hosting the generated MCP server remotely on Cloudflare" and excludes "Cloud SaaS /
multi-tenant" from the MVP. This
Worker does not contradict that: it serves exactly **one fixed, unauthenticated, read-only**
capability that was already committed to the repo and already compiled by the real pipeline
at build time — nobody's business description or CDL is compiled here, there is no
per-visitor session or state, and no arbitrary/visitor-supplied connector ever runs. It is a
growth-page prop, scoped and isolated on purpose. If Archstone product-hosts MCP servers for
real customers later, that is a separate architectural decision (a new ADD), not an extension
of this file.

## How it works

1. `pnpm build:ir` runs the **real** pipeline (`@archstone/schema` `load` →
   `@archstone/compiler` `validateSemantics`/`compile`) against
   `examples/manifests/tourism` — on Node, at build time — and writes the resulting IR to
   `src/ir.generated.json` (gitignored, regenerated on every build/deploy).
2. At the edge, the Worker loads that static IR, builds a `Registry`, and reuses
   `createMcpServer`/`toolDefinitions`/`callTool` from `@archstone/runtime` **unmodified** —
   those functions have no stdio/Node-only dependency, only the SDK's `Server` class.
3. `/mcp` is served over `WebStandardStreamableHTTPServerTransport` (from the already-installed
   `@modelcontextprotocol/sdk`, not currently used anywhere else in the repo) — one transport
   per request, stateless (`sessionIdGenerator: undefined`), matching the SDK's own documented
   Cloudflare Workers usage pattern.
4. `/v1/search` is the mock backend — the same canned response shape as
   [`../mock-stays-server.mjs`](../mock-stays-server.mjs), ported from Node's `http` module to
   a Workers `fetch` handler. `STAYS_API_URL` is resolved per-request to the Worker's own
   origin (`InvokeOptions.env`, not a static env var), so no deployment-time configuration is
   needed for it.

## Commands

```bash
pnpm install                # from archstone/ (workspace root)
pnpm --filter archstone-demo-remote-mcp-worker dev      # wrangler dev on :8787
pnpm --filter archstone-demo-remote-mcp-worker test     # rebuilds IR + runs vitest
pnpm --filter archstone-demo-remote-mcp-worker deploy   # rebuilds IR + wrangler deploy
```

## Manual verification

Point a real Claude Desktop/Claude Code at the deployed (or `wrangler dev`) URL as a **remote**
MCP server (`"type": "url"`, no local process) and ask a travel question — Claude should
discover `tourism_search` and get a real (mocked) answer back. See
`archstone-website`'s `#try-it` section for the exact config snippet shown to visitors.

## Deploying

`../../../.github/workflows/deploy-demo-worker.yml` redeploys automatically on push to
`main` when this folder, the tourism example, or a package it depends on
(`packages/*`, `providers/*`) changes — same idea as `archstone-website` tracking its own
`main` for Cloudflare Pages, just a separate pipeline since the source lives in a different
repo. Manual trigger: `workflow_dispatch` from the Actions tab.

**One-time setup:** add a repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit on the
account that owns `archstone-demo-tourism-mcp`), and `CLOUDFLARE_ACCOUNT_ID` if the token's
account is ambiguous. Create the token in the Cloudflare dashboard — never paste a token
value into a workflow file, an issue, or a PR.

## Rate limiting

`/mcp` and `/v1/search` are public and unauthenticated. Configure Cloudflare's built-in Rate
Limiting on this Worker's route before pointing real website traffic at it — not application
code, a zone/route setting.
