- **`Release prepare` computes the version by default** (`bump: auto`,
  `scripts/classify-bump.mjs`). It classifies the commits since the last `v*` tag by Conventional
  Commits — breaking, then `feat`, then everything else, counting every commit listed in a
  squash body — and names the commits that decided the bump in the run summary. Before 1.0 a
  breaking change bumps the minor, so a computed default never produces 1.0.0; `patch` / `minor` /
  `major` and an explicit `version` still override it. Maintainer tooling only.
