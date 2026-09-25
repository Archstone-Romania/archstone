- **Two CI checks on the changelog, for contributors** (`.github/workflows/ci.yml`). Every pull
  request now either adds a `changelog.d/` fragment (or a line to `CHANGELOG.md`) or carries a
  `Changelog: none — <reason>` line in a commit message or its description
  (`changelog entry or waiver`, `scripts/check-changelog-entry.mjs`); and no pull request may
  change a released `## [x.y.z]` section unless it declares
  `Changelog-correction: <x.y.z> — <reason>` (`released changelog sections are unchanged`,
  `scripts/check-changelog-history.mjs`). The second catches a silent failure: a branch that wrote
  under `[Unreleased]` before a release, rebased after it, has its entries reattached under the
  released heading by git with no conflict, so a shipped version appears to contain later work
  and the next release's notes lack it. See `CONTRIBUTING.md` → "The changelog". No change to
  any published package.
