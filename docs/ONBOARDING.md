# Onboarding

Archstone is a **compiler** for the thing it calls *zero manual integration*: a company
describes what it can do in **CDL** (Capability Definition Language), and Archstone compiles
that description into tools AI agents can execute — no hand-written MCP server, no HTTP glue.

There are three ways to arrive here, and this guide serves all of them:

- **[Provider onboarding](#provider-onboarding)** — you have a business/API and want AI
  agents to be able to use it. You write CDL; Archstone does the integration.
- **[Embedding onboarding](#embedding-onboarding)** — you have (or are generating) a compiled
  IR artifact and want to consume it directly in your own app/agent loop without running
  Archstone's CLI. Zero MCP server process; you get typed tools and fail-closed execution.
- **[Contributor onboarding](#contributor-onboarding)** — you want to build Archstone
  itself (the compiler, providers, runtime).

Pick your path. They don't overlap much.

---

## Provider onboarding

> **Goal:** turn what your company does into agent-callable tools, without writing
> integration code. The entire integration is a handful of lines of CDL.

### What you need

- The Archstone CLI available — `npm install -g @archstone/cli` (or `npx @archstone/cli`), or
  see [Contributor onboarding](#contributor-onboarding) for a local checkout and `pnpm apply` /
  `pnpm serve` instead.
- An HTTP API behind your capability (a REST endpoint the binding points at). For a demo
  you can point at a mock; in production you point at a real backend.

### Try it now (no writing required)

Before writing a line of CDL, run the shipped example and watch the whole pipeline work
end to end — it's the fastest way to see what Steps 1–6 below actually produce:

```bash
pnpm apply examples/manifests/booking     # compile a 4-capability example
pnpm demo:tourism                                    # serve the tourism example over MCP
pnpm demo:mock                                       # (separate shell) a mock backend on :8787
pnpm verify examples/manifests/tourism               # replay the golden fixture, check for drift
```

### The mental model

```mermaid
flowchart LR
    subgraph write["You write"]
        CAPS["capabilities.yaml<br/>the index — what the company offers"]
        CAP["*.capability.yaml<br/>business shape, per capability"]
        RES["*.resource.yaml<br/>named types the output references"]
        BIND["bindings/*.binding.yaml<br/>maps one capability to a real endpoint,<br/>and its response back onto resources"]
    end
    CAPS --> CAP
    CAP --> RES
    CAP --> BIND
    RES --> BIND
    BIND --> APPLY["archstone apply<br/>validate → compile → IR"]
    APPLY --> SERVE["archstone serve<br/>emit MCP tools (stdio) → AI agent"]
    APPLY --> VERIFY["archstone verify<br/>replay a fixture live → drift check"]
```

Business definition (`*.capability.yaml` + `*.resource.yaml`) is kept **separate** from
technical wiring (`bindings/`). That separation is the point: swap the backend, and the CDL
and the generated tool do not change.

### Step 1 — Declare what you offer (`capabilities.yaml`)

This is the root of the diagram above: the compiler loads this file first, and anything not
listed here — a capability, a provider — doesn't exist as far as Archstone is concerned.

The iconic file. Like `openapi.yaml` or `docker-compose.yaml`, but for capabilities.

```yaml
# capabilities.yaml
company:
  id: booking
  name: Booking Holdings
  description: Global accommodation and travel services exposed to AI agents.

capabilities:
  - tourism.search
  - tourism.book

providers:
  - booking-api      # logical backends your capabilities bind to
  - payment
```

### Step 2 — Define each capability (business only)

This expands the `*.capability.yaml` node above, one file per entry you listed in Step 1.
Nothing here is servable yet — it's where you describe the business shape the compiler will
understand, independent of how (or whether) it ends up wired to a real backend.

One file per capability. **No URLs, no auth headers, no HTTP** — just the business shape.

```yaml
# tourism.search.capability.yaml   (CDL 0.2)
capability:
  id: tourism.search
  description: Find accommodation matching customer preferences.
  effect: read                     # read | write — drives safety/consent

  input:
    destination: { type: location }
    dates:       { type: date-range }
    travelers:   { type: party }
    preferences: { type: preference-set, required: false }

  output:
    accommodations:
      collection: Accommodation

  policies:
    - authenticated
    - rate-limited

  provider: booking-api            # which logical provider fulfils it
```

### Step 3 — Define the resources your capability returns (`*.resource.yaml`)

Step 2 referenced `Accommodation` before it was defined anywhere — that's intentional.
Resources live in their own files, the `*.resource.yaml` node above, separate from any one
capability, precisely so multiple capabilities — even across domains — can share the same
named type instead of redefining it inline each time.

`collection: Accommodation` above is a **reference**, not a definition — it must resolve to
a matching resource file, or the manifest fails to compile (`unknown-resource`). One file per
resource, named business entities with typed fields:

```yaml
# tourism.Accommodation.resource.yaml
resource:
  name: tourism.Accommodation
  description: A bookable place to stay matching a traveler's search.
  fields:
    name:
      type: text
      description: The property's display name.
    location:
      type: location
      description: Where the stay is — city, region, or address.
    pricePerNight:
      type: quantity
      description: Nightly rate for the stay.
    rating:
      type: quantity
      required: false
      description: Guest review score, when available.
```

A bare name (`Accommodation`) resolves inside the referring capability's own domain; a
cross-domain reference must be qualified (`tourism.Accommodation`). An ambiguous bare match
is a compile error, never a guess. The compiler carries the resolved fields through to the
emitter, which lowers them into a typed, described JSON Schema `outputSchema` on the tool —
the agent sees `Accommodation` has a `name`/`location`/`pricePerNight`/`rating`, not a bare
`{type: object}`.

> **Gotcha:** a field's own `description:` is used verbatim only for types with no built-in
> description of their own (`text`, `string`, `identifier`, `quantity`, …). For types the
> emitter already describes generically (`location`, `date-range`, `party`, `money`, `date`,
> `datetime`/`time-slot`, `enum`), the generic description wins over whatever you wrote. Don't
> rely on a custom description surfacing for those types.

### Step 4 — Bind it to a real endpoint (`bindings/`)

This is the `bindings/*.binding.yaml` node — the only file in the whole flow allowed to know
about HTTP. Everything you wrote in Steps 2–3 stays true no matter what you point this file at.

The one place technical detail lives. Secrets and hostnames come from the environment
(`${VAR}`), never hard-coded. A binding also maps the provider's response onto the resource
it produces (`response:`) — the resource is the anchor; JSON paths are the only thing that
moves if the backend renames a field:

```yaml
# bindings/tourism.search.binding.yaml
binding:
  capabilityId: tourism.search
  connector:
    type: rest
    rest:
      baseUrl: "${BOOKING_API_URL}"
      method: POST
      path: /api/v1/hotels/search

  response:
    collection: "$.results[*]"        # JSONPath to the item list in the provider body
    resource: Accommodation
    map:
      name: "$.name"
      location: "$.location"
      pricePerNight: "$.pricePerNight"
      rating: "$.rating"              # optional on the resource → may be absent without failing
```

Here's what that provider actually returns — the shape `response:` above is written against:

```json
// POST /api/v1/hotels/search → 200 OK
{
  "results": [
    { "name": "Hotel Azur",    "location": "Nice, France", "pricePerNight": 142, "rating": 4.6 },
    { "name": "Dunes Resort",  "location": "Nice, France", "pricePerNight": 98 }
  ]
}
```

Read the two side by side: `collection: "$.results[*]"` walks into the array; each entry
under `map:` is a JSONPath applied to *one element* of it — `name: "$.name"` pulls
`"Hotel Azur"` straight off the first element, `location: "$.location"` pulls
`"Nice, France"`, and so on. The second result has no `rating` at all — and since `rating`
is `required: false` on `Accommodation` (Step 3), that's fine.

That's the general rule the runtime applies to every mapped element, checked against
`Accommodation`'s required fields:

- every required field present → **OK** — mapped data returned as `structuredContent`;
- an **optional** field missing → **DEGRADED** — returned, that field omitted, a warning surfaced;
- a **required** field missing → **VIOLATION** — fail closed: the tool returns `isError:true` with
  a human-readable `content` message plus a structured error object in
  `CallToolResult._meta["dev.archstone/contract_violation"]` containing `{error: "contract_violation", capability, missing}` — **not** the raw provider body. The agent can branch deterministically on the
  stable error code instead of parsing prose.

A capability with **no** binding still validates — it just isn't invocable yet (`apply`
warns and reports it as not bound). A binding with **no** `response:` still validates too —
the runtime falls back to today's raw pass-through for that tool (rollout-safe), but the
declared `outputSchema` isn't enforced for it. This lets you declare intent before the
mapping exists, but map the response before you trust the shape you get back.

### Step 5 — Compile and inspect

You don't need every capability bound to run this. A capability with no binding still
validates (see the note above), so it's worth running `apply` as soon as Step 3 is done, and
again after every change, rather than treating it as a single gate at the very end.

```bash
archstone apply ./my-manifest-dir
```

You'll see the company, providers, each loaded capability with its `effect` and provider,
schema validation, semantic errors/warnings, and the registry IR summary — e.g.
`registry IR v0 — 4 capabilities, 1 invocable (bound)`. Warnings (unused provider, missing
binding) are safe to iterate on; **errors** must reach zero before you serve.

### Step 6 — Serve it to an AI agent

This is where the IR that `apply` produced becomes something an agent can actually call —
the last arrow in the diagram above.

```bash
archstone serve ./my-manifest-dir
```

This emits your bound capabilities as **MCP tools over stdio**. Point an agent at it. For
Claude Desktop, add the server to `claude_desktop_config.json`, set any `${VAR}` your
bindings use in the `env` block, and restart — the tool (e.g. `tourism_search`) appears and
the agent can call it. A complete, copy-pasteable Claude Desktop walkthrough lives in
[`examples/demo/README.md`](../examples/demo/README.md).

---

### After you ship: keeping the contract honest

Once you're serving real tools to real agents, the backend behind a binding can change shape
without warning — a renamed field, a new required parameter — and nothing above catches that
after the fact. `archstone verify` is how you find out before an agent does. Unlike Steps 1–6,
it isn't something you do once during setup: run it on whatever cadence fits (a cron job, a CI
gate), for as long as the binding is live.

A binding can also declare a `contract:` block — a fingerprint of the provider's response
shape plus a pointer to a golden fixture (`fixtures/<capabilityId>.golden.json`, a recorded
request):

```yaml
  contract:
    source: recorded
    fingerprint: "sha256:…"
    probe:
      fixture: fixtures/tourism.search.golden.json
```

```bash
archstone verify ./my-manifest-dir
```

replays the fixture's request against the **live** backend, runs it through the same
`response:` mapping a real call would use, and reports a per-binding health status:
🟢 unchanged, 🟡 shape drifted or a field degraded, 🔴 a required field went missing or the
request itself failed. It exits non-zero on any 🔴, so it drops straight into a CI job as a
drift gate. It's the only Archstone command that makes a live network call outside a real
tool invocation — on demand only, never triggered by `apply`/`serve`. Wiring it to a schedule
(cron, a CI job) is your call, not Archstone's.

---

## Embedding onboarding

> **Goal:** take a compiled IR artifact and embed it directly in your own application or agent
> loop, consuming typed tools and fail-closed execution without running Archstone's CLI.

### Who this is for

You already have (or are generating) a compiled IR artifact from an Archstone manifest, and you
want to consume it directly in your own product — a web application, a backend service, an AI
agent embedded in another product — without spinning up Archstone's own MCP server process.
For example: an assistant embedded in a travel-booking SaaS wants to call the same tools the
booking backend exposes; you compile the manifest once, ship the IR as a static JSON artifact,
and load it directly into your agent loop.

### Compile and capture the artifact

Start with the same CDL you would use for [Provider onboarding](#provider-onboarding) — all
Steps 1–4 are identical. The difference is in what you do with the result: instead of running
`archstone serve`, compile once and write a portable IR artifact:

```bash
archstone build ./my-manifest-dir
```

This produces `archstone.ir.json` (or `--out <path>` to customize the output location). The
artifact is standalone: it contains the full compiled IR (`version: "0"`), with contract
fingerprints and golden fixtures **stripped** — you ship only the IR itself, making it safe to
include in a built application or serve from a static CDN.

You can commit this artifact to version control, ship it as part of a release, or regenerate
it in your CI/CD pipeline. It's the glue between Archstone's compile pipeline and your own
application.

### Load it into `@archstone/agent`

Install the embedded SDK:

```bash
npm install @archstone/agent
```

Then load the IR and construct an Archstone instance:

```typescript
import { fromIR } from "@archstone/agent";
import fs from "node:fs";

// Load the artifact (e.g., from file, fetch, or inline)
const ir = JSON.parse(fs.readFileSync("archstone.ir.json", "utf-8"));
const archstone = fromIR(ir);
```

If the artifact isn't a valid `version: "0"` IR, `fromIR()` throws an `InvalidArtifactError` —
it fails closed rather than proceeding on a shape it doesn't recognize.

### Generate typed tool definitions

Once you have an Archstone instance, generate tool definitions in your preferred format:

```typescript
// Get tools in your target format (zero MCP SDK loaded here)
const anthropicTools = archstone.tools("anthropic");  // Anthropic SDK format
const openaiTools = archstone.tools("openai");        // OpenAI SDK format
const geminiTools = archstone.tools("gemini");        // Google Gemini format
const jsonSchemaTools = archstone.tools("json-schema"); // Plain JSON Schema
```

Each tool includes a `name`, a `description` (as the AI agent sees it), and an `inputSchema`
(from the semantic types defined in your CDL). The agent can discover and reason about them —
no hand-written tool definitions.

### Invoke capabilities with fail-closed semantics

Execute a capability just as you would in `archstone serve`, but directly in your code:

```typescript
const result = await archstone.execute("tourism.search", {
  destination: "Paris",
  checkInDate: "2026-08-01",
  travelers: { adults: 2, children: 0 },
});

if (result.status === "ok") {
  console.log("Success:", result.data);
} else if (result.status === "degraded") {
  console.log("Partial result:", result.data, "Missing optional fields:", result.degraded);
} else if (result.status === "violation") {
  console.log("Contract violation — required fields missing:", result.missing);
} else if (result.status === "error") {
  console.log("Transport/connector error:", result.error);
}
```

The result mirrors the same **OK/DEGRADED/VIOLATION/ERROR** semantics from
[Step 4's fail-closed mapping](#step-4--bind-it-to-a-real-endpoint-bindings):
- **OK** — all required fields present, returned as `data`.
- **DEGRADED** — optional fields missing, returned as `data` with `degraded` listing the missing names.
- **VIOLATION** — a required field missing; `missing` lists it (structured, not prose), so agents
  can branch deterministically.
- **ERROR** — transport failure (missing env var, network error, non-2xx response); `error` contains
  a human-readable message.

`execute()` accepts an optional `env` object (Workers-style, never `process.env`) for
injecting environment variables into `${VAR}` placeholders in your bindings — useful for
passing secrets or configuration without baking them into the artifact.

```typescript
const result = await archstone.execute(
  "tourism.search",
  { destination: "Paris", checkInDate: "2026-08-01", travelers: { adults: 2 } },
  { env: { BOOKING_API_URL: "https://api.booking.example.com" } }
);
```

### Expose it as an MCP endpoint (optional)

If you want to also surface the embedded instance as an MCP server — for example, to mount it
in the Claude API's `mcp_servers` config or expose it to other clients over HTTP — use the
`/mcp` subpath:

```typescript
import { mcpHandler } from "@archstone/agent/mcp";

const handler = mcpHandler(archstone, {
  bearerToken: process.env.ARCHSTONE_TOKEN, // required; empty throws at construction
});
```

This returns a Web-standard `(request: Request) => Promise<Response>` handler — mountable in
any Web-standard-Request runtime (Cloudflare Workers, Node via a fetch adapter, etc.):

```typescript
// E.g., in a Cloudflare Worker
export default {
  fetch(request: Request): Promise<Response> {
    return handler(request);
  },
};

// E.g., in a Node.js app with a framework like Hono
import { Hono } from "hono";
const app = new Hono();
app.all("*", async (c) => handler(c.req.raw));
```

The handler is a thin wrapper — it reuses the same Registry from the embedded instance, applies
the same bearer-token gate as `archstone serve --http`, and enforces the same "no CORS by
default" posture as the CLI. Never a separate method on the Archstone instance itself — this
separation ensures that consumers who only ever call `tools()`/`execute()` never pull in the
MCP SDK into their bundle (RFC-0008, Architecture Challenge R-1).

The bearer token is **required** and checked at handler construction, not on the first request
(Rule #7 — core never ships open by default). If you're running in an environment without
secrets (e.g., a public demo), you must explicitly provide one anyway, even if it's a dummy
value.

### Where Archstone's own CLI fits

The CLI's `archstone serve --http` command does the same work: it compiles your manifest,
builds a Registry, and wraps it in the same HTTP handler machinery. You use `--http` when you
want Archstone itself to own the server. You use the embedded SDK (`fromIR()` + `mcpHandler()`)
when you want to run the handler inside your own application — giving you full control over
how it's deployed, scaled, and integrated with your existing stack.

```bash
# Archstone runs the HTTP server for you
archstone serve --http ./my-manifest-dir --port 8787 --token "my-secret"

# vs.

# You run the HTTP server; Archstone is just a dependency
// In your app.ts:
const archstone = fromIR(compiledArtifact);
const handler = mcpHandler(archstone, { bearerToken: "my-secret" });
// Mount handler on your framework of choice
```

Both paths produce the same MCP protocol behavior — the difference is operational.

---

## Contributor onboarding

> **Goal:** get a green checkout, understand the layout, and know how work is done here
> before you touch code.

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22+ (repo developed on 26) |
| pnpm | 11+ (`packageManager` pins the exact version) |
| Git | any recent |

### Get a green checkout

```bash
git clone https://github.com/Archstone-Romania/archstone
cd archstone
pnpm install
pnpm lint             # eslint
pnpm typecheck        # tsc, strict
pnpm test             # vitest — includes the end-to-end MCP demo integration test
```

Then confirm the pipeline runs end to end:

```bash
pnpm demo:booking     # apply the booking manifest → validation + IR report
pnpm demo:tourism     # serve the tourism manifest as MCP tools
```

If `lint`, `typecheck`, `test`, and the demos all succeed, your environment is good. These
are the same four checks CI runs on every PR (see "Contributing a change" below) — green
locally means a PR you open won't fail for reasons unrelated to your change.

### Repository layout

```mermaid
flowchart TD
    ROOT["archstone/"]
    ROOT --> PKG["packages/"]
    PKG --> SCHEMA["schema/<br/>schemas/ — cdl.schema.json validates the language"]
    PKG --> COMPILER["compiler/<br/>compile → IR (src/ir.ts is the moat: target-agnostic)"]
    PKG --> EMITTER["emitter-support/<br/>IR indexing, semantic-type → JSON-Schema, response mapping"]
    PKG --> RUNTIME["runtime/<br/>registry + MCP emitter (stdio) + HTTP handler"]
    PKG --> AGENT["agent/<br/>embedded SDK: fromIR, tools(format), execute, /mcp handler"]
    PKG --> CLI["cli/<br/>archstone apply / build / serve / verify — wires the pipeline"]
    ROOT --> PROVIDERS["providers/"]
    PROVIDERS --> REST["rest/<br/>REST adapter (providers = adapters)"]
    ROOT --> EXAMPLES["examples/<br/>manifests + the Claude demo"]
    ROOT --> DOCS["docs/<br/>ONBOARDING.md (this guide)"]
```

The compiler never lets `apply` poke a target directly — it compiles to an **IR**, and
emitters (MCP now; REST · GraphQL · SDK later) consume the IR. Keep that boundary intact:
the IR is the reason the product survives a protocol change.

### Contributing a change

Standard open-source flow:

1. Fork the repo and create a branch.
2. Make your change. Keep `pnpm typecheck` and `pnpm test` green.
3. Open a pull request against `main`. CI runs typecheck + test on every PR.

Small, focused PRs merge fastest. If you're proposing something larger (a new provider type,
a change to the IR or CDL), open an issue first so the design can be discussed before you
build.

### Conventions

- **Schema before core.** The language (`schemas/`) and its examples are validated before
  the compiler that consumes them. Don't build a feature ahead of the schema that defines it.
- **CDL is business-only.** Anything technical (URLs, auth, HTTP verbs) belongs in a
  `binding`, never in a `*.capability.yaml`.
- **Respect the layer boundaries.** The IR is target-agnostic (no MCP, no HTTP, no JSON Schema).
  The MCP SDK appears only in `runtime`'s emitter and `agent`'s `/mcp` subpath. Semantic-type
  → JSON-Schema lowering and response mapping live in `emitter-support`, shared by all emitters.
  HTTP appears only in `providers/`. The compiler never wires YAML directly to MCP or HTTP.
- **TypeScript strict**, pnpm workspaces, Vitest.

### Where to look first

| To understand | Read |
|---|---|
| The language, by example | [`examples/manifests/`](../examples/manifests/) |
| The wire format (schemas) | [`packages/schema/schemas/`](../packages/schema/schemas/) |
| The moat (IR) | [`packages/compiler/src/ir.ts`](../packages/compiler/src/ir.ts) |
| Embedding the SDK | [`packages/agent/README.md`](../packages/agent/README.md) |
| Response mapping & JSON-Schema lowering | [`packages/emitter-support/`](../packages/emitter-support/) |
| The end-to-end demo | [`examples/demo/README.md`](../examples/demo/README.md) |
