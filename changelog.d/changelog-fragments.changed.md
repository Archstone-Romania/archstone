- **Changelog entries now go in `changelog.d/`, one file per change, instead of in
  `CHANGELOG.md`.** Before, every PR added its entry at the top of the same `[Unreleased]`
  list, so almost every merge put the other open PRs in conflict. `Release prepare` now folds
  `changelog.d/<slug>.<category>.md` files into the version section and deletes them, and
  `Release tag` refuses a fragment merged after that step. CI also runs the release-script
  tests (`node --test scripts/*.test.mjs`) on every PR. Before, they ran only inside the
  release workflows, which is why the `providers/sql` omission surfaced at release time.
  See [`changelog.d/README.md`](changelog.d/README.md).
