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
pnpm lint             # eslint
pnpm typecheck        # tsc, strict
pnpm test             # vitest — includes the end-to-end MCP demo
pnpm demo:booking     # the pipeline, end to end
```

Node 22+ · pnpm 11+. When running a single test file directly with `pnpm exec vitest run`, build the affected package first — tests import by package name and resolve to `dist/`, so without rebuild you'll test stale code. Use `pnpm test` to build everything at once.

## Making a change

1. Fork and create a branch.
2. Keep `pnpm typecheck` and `pnpm test` green.
3. Record the change in [`CHANGELOG.md`](CHANGELOG.md) — see [The changelog](#the-changelog).
4. Open a PR against `main` — CI runs typecheck + test on every PR, plus the two changelog checks.

Small, focused PRs merge fastest. For anything larger (a new provider type, a change to the
IR or CDL), open an issue first so the design can be discussed.

## The changelog

`CHANGELOG.md` is the release notes. When a release is cut, its `## [Unreleased]` heading is
renamed to the version number and published as-is as the GitHub Release — nobody rewrites it
afterwards from commit subjects. So the entry is written by the PR that makes the change, and
two CI checks hold every PR to that:

- **`changelog entry or waiver`** — the PR adds at least one line to `CHANGELOG.md`, under
  `## [Unreleased]`, in the style of the entries already there (what changed for someone using
  the published packages, and the package it is in). If nothing in the PR is visible to them —
  CI, tests, internal docs — say so instead, on a line of its own in a commit message **or** the
  PR description:

  ```
  Changelog: none — <why a user would not notice>
  ```

  A bare `Changelog: none` is refused; the reason is what the reviewer reads. The check re-reads
  the PR description when it runs, so after editing the description, re-run the check.

- **`released changelog sections are unchanged`** — never edit a `## [x.y.z]` section. It
  describes a version people may already be running. This usually fails *by accident*: you wrote
  entries under `## [Unreleased]`, a release renamed that heading on `main`, and when you rebased,
  git reattached your lines under the released heading — no conflict, nothing odd in the diff.
  After any rebase across a release, open `CHANGELOG.md` and look at where your entries actually
  are; move them back under `## [Unreleased]`. If you really are correcting a released section,
  declare it (once per version touched, in a commit message or the PR description):

  ```
  Changelog-correction: <x.y.z> — <what was wrong>
  ```

Commits whose subject starts with `chore(release):` — the release-prepare stamp — are exempt from
the first check.

## Adding a dependency

Before adding a new dependency, or bumping an existing one, check its advisory history yourself —
`npm audit` locally after the change, or a quick look at the
[GitHub Advisory Database](https://github.com/advisories) for that package — rather than finding
out only when CI flags it. CI's dependency-audit gate (`.github/workflows/audit.yml`) is a
backstop, not the first line of defense: by the time it runs on your PR, you've already picked the
package and the version, and reworking that choice after a red build is more expensive than a
minute of checking beforehand. The gate does fail a PR that introduces a version carrying a known
advisory (moderate severity or above) that the base branch didn't already have — see that
workflow's own header comment for exactly what it checks — but don't rely on it to do your
research for you.

## Releasing

Cutting a release is a maintainer action, not a contributor one — it's covered here because the
whole flow lives in three workflows and nowhere else. It's three acts, two of them human:

1. **Dispatch `Release prepare`** (`workflow_dispatch` on `.github/workflows/release-prepare.yml`,
   run against `main`). Dispatching it is the decision to release — nothing does that on a
   schedule or on merge. The *number* is computed by default: with `bump: auto`,
   `scripts/classify-bump.mjs` reads the commits since the last `v*` tag by Conventional Commits
   (a `type!:` header or `BREAKING CHANGE:` footer beats `feat:`, which beats everything else;
   inside a squash body every listed commit counts) and the run summary lists each commit and
   names the ones that decided it. While the major is 0 a breaking change bumps the **minor**, so
   the default never produces 1.0.0; that takes `bump: major` or an explicit `version`, which —
   like `patch`/`minor` — override the computed number whenever you want to. It stamps
   the root `package.json`, every publishable package under `packages/` and `providers/`
   (discovered by `private: false`, not hardcoded), and `server.json`; turns the CHANGELOG's
   `## [Unreleased]` heading into `## [X.Y.Z]` and opens a fresh, empty `Unreleased` above it; then
   pushes `release/prepare-X.Y.Z` and stops. It refuses to run if `[Unreleased]` has no entries —
   there would be nothing to announce.
2. **Open and merge that PR yourself.** The workflow deliberately doesn't open it: a PR raised
   with the default `GITHUB_TOKEN` still needs a manual "approve workflow run" click before CI
   runs on it, which is exactly as much human effort as opening the PR directly, without adding a
   stored PAT or GitHub App token this repo otherwise has no use for (npm publishing is OIDC —
   there is no `NPM_TOKEN`).
3. **Dispatch `Release tag`** (`.github/workflows/release-tag.yml`) with the version, once the
   prepare PR is merged and green. It re-verifies the merge commit is stamped and that the
   CHANGELOG has a non-empty `## [X.Y.Z]` section, pushes the `vX.Y.Z` tag, and explicitly
   dispatches `release.yml` — a tag pushed by `GITHUB_TOKEN` does not start a workflow on its own.
4. **`release.yml`** runs from the tag: lint, typecheck, the full test suite, and a release-only
   gate that packs and installs every package end to end — then publishes the 9 `@archstone/*`
   packages to npm via OIDC and creates the GitHub Release from that CHANGELOG section.

If a run stops partway, resume it via that same workflow's own `workflow_dispatch` with the same
version — never delete and re-push a tag.

## Conventions

- **Schema before core** — don't build a feature ahead of the schema that defines it.
- **CDL is business-only** — URLs, auth, and HTTP verbs belong in a `binding`, never in a
  `*.capability.yaml`.
- **Respect the layer boundaries** — the MCP SDK lives only in the emitter/runtime; HTTP
  lives only in `providers/`; the compiler and IR know neither.
- TypeScript strict · pnpm workspaces · Vitest.

## Generative AI

Using an AI assistant to write a contribution is fine. Submitting work you do not understand is
not. The project's own use of generative AI is described in the
[README](README.md#how-this-project-uses-generative-ai); this is what we ask of you.

**Required:**

- **Disclose it.** If a commit contains generated code, name the model and its version in the
  co-authorship trailer, and say in the PR description what was generated and what you wrote.
  Prose help — a reworded doc, a commit message — needs no ceremony.
- **Be able to explain every line you submit.** Review asks *why*, not just whether CI is green.
  "The model wrote it" is not an answer, and a PR whose author cannot defend its design is closed
  even if it passes.
- **Check the licence.** By contributing you assert the work is yours to license under
  Apache-2.0. Output reconstructed from incompatible sources is not, and neither of us can fix
  that after it merges.

**Read the specification before generating anything that touches these:**

- **`effect`** (`read` / `write` / `irreversible`). Getting it wrong is not a style defect — it is
  the difference between looking up a price and charging a card, and it reaches a customer through
  an agent.
- **The response-mapping boundary.** That an undeclared provider field never reaches a model is a
  stated guarantee, not an implementation detail
  ([ADR-0008](docs/adr/0008-undeclared-provider-data-never-reaches-a-model.md)).
- **Anything under `packages/schema/`.** The schema defines the language; a plausible-looking
  addition is a language change.

**Design decisions are not generated.** A change to CDL, the IR, or a compiler guarantee needs an
ADR — alternatives considered, argued by a person. Open an issue first.

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).
