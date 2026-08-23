# Deploy: your capabilities as a remote MCP endpoint

`archstone serve` runs on your machine. That is enough for Claude Desktop over stdio, and it is
not enough for anything else — ChatGPT, Claude on the web or a phone, or a teammate all need a
**public HTTPS endpoint**. This template is the shortest honest path from one to the other.

It is a copy-and-edit starting point, not a package to depend on. **Archstone does not host
anything for you**, and this directory is what that looks like: your Worker, your Cloudflare
account, your backend, your token.

---

## What you need first

A manifest that compiles. If you don't have one, start there — `archstone init openapi.yaml
--out manifest` reads an API description you already have and writes one.

```bash
archstone apply ./manifest     # green before you deploy anything
```

## 1. Copy this directory

```bash
cp -r examples/deploy/cloudflare-worker my-archstone-mcp
cd my-archstone-mcp
npm install
```

Rename the Worker in `wrangler.jsonc` — `"name"` becomes your `*.workers.dev` subdomain.

## 2. Compile your manifest into the Worker

```bash
archstone build ./manifest --out src/archstone.ir.json
```

`archstone.ir.json` is the deployment unit. It carries your capabilities, bindings and policy
rules, and it deliberately does **not** carry contract fixtures — those are a
`archstone verify` concern and have no business in a production bundle.

> **This artifact is a build output, not source.** Re-run `archstone build` and redeploy after
> any manifest change, including a `*.policy.yaml` edit. A stale artifact enforces stale policy,
> silently and confidently.

## 3. Set the secrets

```bash
# Gates who may reach the endpoint at all. Generate something unguessable:
openssl rand -hex 32 | wrangler secret put ARCHSTONE_HTTP_TOKEN

# Then one per `${NAME}` your bindings reference — base URLs, API keys:
wrangler secret put BOOKING_API_URL
```

Use `wrangler secret put`, not `vars` in `wrangler.jsonc`. Anything in `vars` is plaintext in
your dashboard and echoed by `wrangler deploy`.

**The token is not user authentication.** It decides who may reach the endpoint; it says nothing
about *whose data* a call acts on. If your capabilities are per-user, you also need
`resolveCaller` — see the commented block in `src/index.ts`.

## 4. Deploy

```bash
npm run deploy
```

## 5. Check it actually serves

Substitute your Worker URL and token:

```bash
curl -s -X POST https://my-archstone-mcp.<subdomain>.workers.dev/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get your capabilities back as tools. Two useful negative checks: the same request
**without** the `authorization` header must return `401`, and it must not leak any tool names in
the body.

---

## Then point an assistant at it

Claude (web, desktop, mobile) → **Settings** → **Connectors** → **Add custom connector**, and
give it `https://.../mcp` plus the bearer token.

---

## Notes worth reading once

**Why `nodejs_compat` is on.** `@archstone/runtime` and the MCP SDK use `node:` builtins. Remove
the flag and the Worker fails at deploy, not at runtime.

**Why the handler is built per request.** `env` only exists inside `fetch` in the Workers module
format. `fromIR` — the part that actually costs anything — is hoisted to module scope and runs
once per isolate.

**Rate limiting, if you declare it.** A capability with `spec.rateLimit` **denies every call**
unless you supply a `rateLimitCounter`, by design: a declared control that silently does nothing
is worse than no control. The in-memory reference implementation is *not* valid here — a Worker
isolate can be created per request, so its counters reset constantly and bound nothing. Back it
with a Durable Object or an external store, or don't declare `rateLimit`.

**Not this template's job:** custom domains, staging environments, CI deploys, or Cloudflare
Access in front of the Worker. All are normal Workers concerns and Cloudflare documents them
better than this file could.
