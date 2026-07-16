# Archstone — Capability Platform

> ## Zero manual integration.
> A company describes what it can do. AI agents can execute it. Nobody hand-writes integration code.

That sentence — **zero manual integration** — is the product. Not MCP, not YAML, not AI, not
the runtime. Those are *how*; *zero manual integration* is *what*.

> **Archstone is not an MCP server. It is a compiler that, in its first release, generates one.**

This is not a semantic distinction. It is the difference between a point product and a
platform: the compiler takes one capability definition (CDL) and emits MCP today, and
REST · GraphQL · SDK · CLI tomorrow — the product survives when the protocol changes.

Open-source **Capability Platform**, Apache-2.0.

---

## How it works

```
capabilities.yaml   →   *.capability.yaml   →   bindings/*.binding.yaml
(what the company     (each capability:        (how one capability maps
 offers — the index)   business shape only)     to a real HTTP endpoint)

        └──────── archstone apply ────────┘        └── archstone serve ──┘
             parse → validate → compile → IR          emit MCP tools → agent
```

You describe capabilities in **CDL** (Capability Definition Language) — business only, no
integration code. Archstone compiles that to a target-agnostic **IR**, and an emitter turns
the IR into tools an AI agent can call. Swap the backend; the CDL and the generated tool do
not change.

Capability outputs reference named **resources** (`*.resource.yaml`); the compiler resolves
them into a typed, described `outputSchema`, and a binding's `response:` mapping enforces
that shape at every call — a required field missing from the provider's response fails
closed (a structured error, never a silent raw pass-through). `archstone verify` replays a
recorded fixture against the live backend on demand and reports a 🟢/🟡/🔴 health status per
binding, so contract drift shows up before an agent hits it.

---

## Quick start

**From source (this repository):**

```bash
pnpm install

# Compile a manifest: validate + lower to IR
pnpm apply examples/manifests/booking

# Serve it to an AI agent as MCP tools over stdio
pnpm serve examples/manifests/tourism

# Replay a binding's golden fixture against the live backend; detect drift
pnpm verify examples/manifests/tourism
```

**From npm (standalone CLI):**

```bash
# Install globally or use npx
npm install -g @archstone/cli
# or
npx @archstone/cli apply <manifest-dir>

# Then run the same commands:
archstone apply examples/manifests/booking
archstone serve examples/manifests/tourism
archstone verify examples/manifests/tourism
```

New here? Start with the **[onboarding guide](docs/ONBOARDING.md)** — one path for
**providers** (expose your business to agents) and one for **contributors** (build
Archstone).

---

## Start here

| Read first | Path |
|---|---|
| **Onboarding** | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| **CDL by example** | [`examples/manifests/booking/`](examples/manifests/booking/) |
| **The schemas (wire format)** | [`packages/schema/schemas/`](packages/schema/schemas/) |
| **End-to-end demo (Claude)** | [`examples/demo/README.md`](examples/demo/README.md) |

---

## Repository layout

```
archstone/
├── packages/
│   ├── schema/
│   │   └── schemas/  # JSON Schema — cdl.schema.json validates the language
│   ├── compiler/     # compile → IR  (src/ir.ts = the moat: target-agnostic)
│   ├── runtime/      # registry + MCP emitter (stdio)
│   └── cli/          # `archstone apply` / `serve` — wires the pipeline
├── providers/
│   └── rest/         # REST adapter (providers = adapters)
├── examples/         # manifests + the Claude demo
└── docs/             # rfc/ · adr/ · spec/ · glossary/ · ONBOARDING.md
```

The compiler never lets `apply` poke a target directly — it compiles to an **IR**, and
emitters (MCP now; REST · GraphQL · SDK later) consume the IR. That boundary is why the
product survives a protocol change.

---

## The iconic file

`capabilities.yaml` is to Archstone what `openapi.yaml` is to an API or `docker-compose.yaml`
is to a stack: the one file that declares what a company offers. See the
[booking example](examples/manifests/booking/).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[contributor onboarding](docs/ONBOARDING.md#contributor-onboarding). Requires Node 22+ and
pnpm 11+; `pnpm typecheck && pnpm test` should be green before you open a PR.

---

## License

[Apache-2.0](LICENSE).

*Archstone · schema-first · Capability Platform*
