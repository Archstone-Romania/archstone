# Case study — ArtVinci

**[ArtVinci](https://artvinci.ro) is a custom-framing business.** Its site runs an assistant,
*Meșterul*, that answers customer questions from the company's real catalog and real pricing —
computed live by ArtVinci's own backend, through capabilities compiled by Archstone.

This is the first production deployment of Archstone, and it is also where a good part of the
compiler got debugged. Everything below is what actually shipped, not an illustration.

---

## What a customer sees

Captured live on `artvinci.ro`, 2026-07-25. Asked in Romanian; translated here.

> **Customer:** How much does a frame cost for a 40×50cm painting?
>
> *→ invokes `framing.estimate-frame-price` against ArtVinci's real catalog*
>
> **Meșterul:** For a painting sized 40×50cm, here are estimates from a few of our profiles:
> AV22, antiqued gold-blue — 63.80 RON; AV8, brown wood with patina — 79.39 RON; AV12, gold
> wood — 563.08 RON. These prices are calculated for the exact dimensions given — tell me a
> style, material or color you prefer and I can narrow it down further.

Those numbers are not a lookup table. The dimensions go to ArtVinci's pricing service, which
computes per-profile prices for that exact size and returns them; the assistant reports what
came back. Nothing was hand-written to make that call happen.

## What ArtVinci actually wrote

Two capabilities:

| Capability | Effect | What it does |
|---|---|---|
| `framing.list-frame-profiles` | `read` | Enumerate the available frame profiles |
| `framing.estimate-frame-price` | `read` | Price a given profile for given dimensions |

The whole contract is **nine files** — `capabilities.yaml`, two `*.capability.yaml`, two
`*.resource.yaml`, two `bindings/*.binding.yaml`, and two golden fixtures. The capability
files contain business meaning only: no HTTP verbs, no URL templates, no JSON Schema, no MCP
SDK. The two binding files are the only place `https://api.artvinci.ro` is named at all.

Everything the assistant needs in order to discover and call these — tool definitions, input
schemas, typed output schemas, response mapping, validation — is generated from those nine
files.

## Where the manifest lives

**In ArtVinci's own repository**, not in Archstone's. This is the ratified pattern: a
business's CDL is that business's source code, versioned alongside the rest of its app.

ArtVinci's build runs `archstone build` over its vendored manifest, producing a portable
`archstone.ir.json` artifact that is committed to the repo. A `verify-ir-artifact` CI job
rebuilds it and fails the build if the committed artifact drifts from the manifest —
byte-identical or nothing. Its only checkout step checks out ArtVinci's own repository: no
cross-repo credentials, no Archstone checkout, no fetch-at-runtime.

## How it runs in production — no MCP server process

ArtVinci does not run `archstone serve`. It loads the compiled IR artifact directly with the
embedded SDK:

```typescript
const result = await archstone.execute("framing.estimate-frame-price", input);
```

Same IR, same validation, same fail-closed response mapping as the MCP path — just no separate
process to deploy or keep alive. This is the point of compiling to a target-agnostic IR: MCP is
one emitter, not the product. The site that most depends on Archstone in production is the one
that never speaks MCP.

## What dogfooding it cost us

Running a real business on the compiler found real bugs, and they were fixed rather than worked
around:

- **`rest.query` remapping** — a snake_case query-parameter mapping broke against ArtVinci's
  actual API shape. Now covered by a permanent regression test.
- **Identity fields** — `framing.estimate-frame-price` takes a frame profile *by id*, and the
  compiler was expanding that into a full nested object in the input schema, which asked the
  model for data it did not have. `ref:` on a resource now lowers to a bare identifier.
- **Spend visibility** — running an assistant on real traffic surfaced that there was no way to
  observe raw provider responses for cost accounting. That became an `onResponse` passthrough
  hook, which fires even when a response fails validation.

Each of these is the kind of thing no example manifest would have found.

---

*Want your business in this position? See the [onboarding guide](docs/ONBOARDING.md), or write
to `hello@archstone.dev`.*
