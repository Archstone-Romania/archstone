# Onboarding

Archstone is a **compiler** for the thing it calls *zero manual integration*: a company
describes what it can do in **CDL** (Capability Definition Language), and Archstone compiles
that description into tools AI agents can execute — no hand-written MCP server, no HTTP glue.

There are two ways to arrive here, and this guide serves both:

- **[Provider onboarding](#provider-onboarding)** — you have a business/API and want AI
  agents to be able to use it. You write CDL; Archstone does the integration.
- **[Contributor onboarding](#contributor-onboarding)** — you want to build Archstone
  itself (the compiler, providers, runtime).

Pick your path. They don't overlap much.

---

## Provider onboarding

> **Goal:** turn what your company does into agent-callable tools, without writing
> integration code. The entire integration is a handful of lines of CDL.

### What you need

- The Archstone CLI available (from this repo: `pnpm apply` / `pnpm serve` — see
  [Contributor onboarding](#contributor-onboarding) for a local checkout, or install the
  published CLI once available).
- An HTTP API behind your capability (a REST endpoint the binding points at). For a demo
  you can point at a mock; in production you point at a real backend.

### The mental model

```
capabilities.yaml   →   *.capability.yaml   →   bindings/*.binding.yaml
(what the company     (each capability:        (how one capability maps
 offers — the index)   business shape only)     to a real HTTP endpoint)

        └────────────  archstone apply  ────────────┘
                     validate → compile → IR
                              │
                     archstone serve
                     emit MCP tools (stdio) → AI agent
```

Business definition (`*.capability.yaml`) is kept **separate** from technical wiring
(`bindings/`). That separation is the point: swap the backend, and the CDL and the generated
tool do not change.

### Step 1 — Declare what you offer (`capabilities.yaml`)

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

### Step 3 — Bind it to a real endpoint (`bindings/`)

The one place technical detail lives. Secrets and hostnames come from the environment
(`${VAR}`), never hard-coded.

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
```

A capability with **no** binding still validates — it just isn't invocable yet (`apply`
warns and reports it as not bound). This lets you declare intent before the wiring exists.

### Step 4 — Compile and inspect

```bash
archstone apply ./my-manifest-dir
```

You'll see the company, providers, each loaded capability with its `effect` and provider,
schema validation, semantic errors/warnings, and the registry IR summary — e.g.
`registry IR v0 — 4 capabilities, 1 invocable (bound)`. Warnings (unused provider, missing
binding) are safe to iterate on; **errors** must reach zero before you serve.

### Step 5 — Serve it to an AI agent

```bash
archstone serve ./my-manifest-dir
```

This emits your bound capabilities as **MCP tools over stdio**. Point an agent at it. For
Claude Desktop, add the server to `claude_desktop_config.json`, set any `${VAR}` your
bindings use in the `env` block, and restart — the tool (e.g. `tourism_search`) appears and
the agent can call it. A complete, copy-pasteable Claude Desktop walkthrough lives in
[`examples/demo/README.md`](../examples/demo/README.md).

### Try it now (no writing required)

```bash
pnpm apply examples/manifests/booking     # compile a 4-capability example
pnpm demo:tourism                                    # serve the tourism example over MCP
pnpm demo:mock                                       # (separate shell) a mock backend on :8787
```

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
pnpm typecheck        # tsc, strict
pnpm test             # vitest — includes the end-to-end MCP demo integration test
```

Then confirm the pipeline runs end to end:

```bash
pnpm demo:booking     # apply the booking manifest → validation + IR report
pnpm demo:tourism     # serve the tourism manifest as MCP tools
```

If `typecheck`, `test`, and the demos all succeed, your environment is good.

### Repository layout

```
archstone/            # repository root
├── packages/
│   ├── schema/       # load + shape-validate CDL manifests
│   ├── compiler/     # compile → IR  (src/ir.ts is the moat: target-agnostic)
│   ├── runtime/      # registry + MCP emitter (stdio)
│   └── cli/          # `archstone apply` / `serve` — wires the pipeline
├── providers/
│   └── rest/         # REST adapter (providers = adapters)
├── schemas/          # JSON Schema — cdl.schema.json validates the language
├── examples/         # manifests + the Claude demo
└── docs/             # ONBOARDING.md (this guide)
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
- **Respect the layer boundaries.** The MCP SDK lives only in the emitter/runtime; HTTP lives
  only in `providers/`; the compiler and IR know neither.
- **TypeScript strict**, pnpm workspaces, Vitest.

### Where to look first

| To understand | Read |
|---|---|
| The language, by example | [`examples/manifests/`](../examples/manifests/) |
| The wire format (schemas) | [`schemas/`](../schemas/) |
| The moat (IR) | [`packages/compiler/src/ir.ts`](../packages/compiler/src/ir.ts) |
| The end-to-end demo | [`examples/demo/README.md`](../examples/demo/README.md) |
