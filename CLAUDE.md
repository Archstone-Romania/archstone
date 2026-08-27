# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## What this is

Archstone — a **compiler** for AI capabilities. A business describes what it can do once, in CDL
(the Capability Definition Language); the compiler lowers that to a target-agnostic IR, and
emitters generate what an agent needs. MCP today, other protocols as they arrive.

It is **not** an MCP server. It generates one, and that distinction is the product: change the
protocol and you regenerate rather than rewrite.

## Where development happens

This repository is the home of the core — CDL, the compiler, the IR, emitters, runtime, CLI,
embedded SDK and provider adapters. Issues, pull requests, CI and releases belong here.

> **⚠️ Transitional, as of 2026-08-26.** The move is ratified but has not run. Until it does,
> this repository still receives **release snapshots** from a private development repository, and
> a snapshot's tree replaces this one wholesale. **A change merged here that is not also in the
> development tree is erased at the next release, silently.** If you are an agent working for the
> maintainer, make core changes in the development repository, not here. If you are an outside
> contributor, open the PR here as `CONTRIBUTING.md` says — it will be re-applied upstream by
> hand until the migration completes.

Planning material — product strategy, commercial artifacts, pricing, research — lives in a
private repository and always will. What reaches this one is the work and the technical argument
for it, never the commercial reasoning behind choosing it.

The hosted commercial product will live in its own separate repository and depend on
`@archstone/*` from npm. **The core must never depend on it.** That direction is permanent and is
the mechanical form of the open-core commitment in
[`docs/adr/0005-open-core-boundary-artifact-guarantee.md`](docs/adr/0005-open-core-boundary-artifact-guarantee.md).

## Commands

```bash
pnpm install
pnpm lint                 # eslint
pnpm typecheck            # tsc, strict
pnpm test                 # vitest — includes the end-to-end MCP demo
pnpm apply   examples/manifests/booking     # validate + lower to IR
pnpm build   examples/manifests/tourism     # portable IR artifact
pnpm serve   examples/manifests/tourism     # emit MCP tools over stdio
pnpm verify  examples/manifests/tourism     # replay a fixture, report drift
```

Node 22+ · pnpm 11+. A single test file: `pnpm exec vitest run packages/compiler/test/compile.test.ts`.

## The pipeline

`packages/schema` (load + shape-validate manifests) → `packages/compiler` (semantic validation,
lowering to IR, JSONPath and fingerprint helpers) → `packages/emitter-support` (IR indexing,
semantic-type → JSON-Schema lowering, response mapping — the shared substrate for every emitter,
MCP-SDK-free and fs-free) → `packages/runtime` (Registry-from-disk, MCP emitter and transport,
verify) → `packages/cli`. `providers/rest` is the only package that touches HTTP.

Layer rules that are not style preferences:

- The MCP SDK appears only in MCP-transport modules. Semantic-type → JSON-Schema lowering lives
  only in `emitter-support`, never in the compiler or IR, and is shared rather than
  re-implemented per target.
- CDL is business-only. URLs, auth and HTTP verbs belong in a binding, never in a
  `*.capability.yaml`.
- Don't build a feature ahead of the schema that defines it.

## Things that are guarantees, not implementation details

Read the decision before changing any of these — each is a published ADR in
[`docs/adr/`](docs/adr/), with the alternatives that were refused:

- **An undeclared provider field never reaches a model.** Unmapped fields are dropped at the
  mapping boundary. There is no flag, no per-binding escape hatch, no trusted-provider mode.
- **`archstone build` and `archstone serve` never require a network call, an account or a key.**
  No telemetry, licence check or registry lookup may enter that path, however convenient.
- **`effect` (`read` / `write` / `irreversible`) is human-confirmed, never inferred.** It is the
  difference between looking up a price and charging a card, and no specification states it.

## Generative AI

This project is written with substantial AI assistance and says so — see
[`README.md`](README.md#how-this-project-uses-generative-ai) for the stance and
[`CONTRIBUTING.md`](CONTRIBUTING.md#generative-ai) for what is asked of contributors. The rule
that matters for an agent working here: **a patch nobody can explain does not merge.** Structural
decisions are ADRs, argued by a person, before the code.
