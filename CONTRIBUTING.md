# Contributing to Archstone

Thanks for your interest in Archstone — a **compiler** for *zero manual integration*.

The full guide is in
**[`docs/ONBOARDING.md` → Contributor onboarding](docs/ONBOARDING.md#contributor-onboarding)**.
This page is the quick reference.

## Quick start

```bash
git clone https://github.com/Archstone-Romania/archstone
cd archstone
pnpm install
pnpm typecheck        # tsc, strict
pnpm test             # vitest — includes the end-to-end MCP demo
pnpm demo:booking     # the pipeline, end to end
```

Node 22+ · pnpm 11+.

## Making a change

1. Fork and create a branch.
2. Keep `pnpm typecheck` and `pnpm test` green.
3. Open a PR against `main` — CI runs typecheck + test on every PR.

Small, focused PRs merge fastest. For anything larger (a new provider type, a change to the
IR or CDL), open an issue first so the design can be discussed.

## Conventions

- **Schema before core** — don't build a feature ahead of the schema that defines it.
- **CDL is business-only** — URLs, auth, and HTTP verbs belong in a `binding`, never in a
  `*.capability.yaml`.
- **Respect the layer boundaries** — the MCP SDK lives only in the emitter/runtime; HTTP
  lives only in `providers/`; the compiler and IR know neither.
- TypeScript strict · pnpm workspaces · Vitest.

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).
