# changelog.d

Unreleased changelog entries, one file per change. Adding a file here instead of editing
`CHANGELOG.md` means two pull requests never touch the same lines, so they do not conflict with
each other.

## Adding an entry

Create `changelog.d/<slug>.<category>.md`:

- **`<slug>`**: anything unique and descriptive, in lowercase letters, digits, `.`, `_` or `-`.
  The branch name works well: `sql-release-lists.fixed.md`.
- **`<category>`**: one of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`
  ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/)'s headings).

Write the body exactly as it should read under that `### Category` heading. That is usually one
bullet:

```markdown
- **`@archstone/provider-sql` was left out of the release pipeline.** `providers/sql` is
  `private: false`, but `release.yml`'s stamp-assert and publish loops did not list it…
```

Don't put a `#`, `##` or `###` heading in the file: the category comes from the file name. One
change can have more than one file if it belongs under more than one category, for example a
`.fixed.md` and a `.changed.md` for a fix that is also breaking.

## What happens at release

`Release prepare` (`scripts/release-prepare.mjs`) reads every file here, in file-name order.
Each one goes under its category in the `## [Unreleased]` section of `CHANGELOG.md`. Entries
already there are kept, and new ones follow them. The section then becomes `## [X.Y.Z]`, and the
files are deleted in the same PR. A file with a name or content it cannot place fails that step,
and so does CI on the PR that added it (`scripts/release-prepare.test.mjs`).

A file merged after the release was prepared but before it was tagged makes `Release tag`
refuse. Its change would be in the tag with no release note. Fold it into the new version's
section by hand, or prepare the release again.
