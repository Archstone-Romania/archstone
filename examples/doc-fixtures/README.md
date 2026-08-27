# Doc fixtures (dev-57)

Support files for `scripts/verify-doc-snippets.mjs` — the check that compiles every
`archstone-fixture`-annotated ` ```yaml ` block published in `README.md`, `CASE-STUDY.md` and
`docs/ONBOARDING.md`.

## Why this exists

A doc snippet is deliberately partial — it shows one capability, not the surrounding
`capabilities.yaml`, resource and binding a real manifest needs to compile. Completing that
fragment automatically (synthesizing a minimal `capabilities.yaml`, stubbing whatever resource
names the snippet references) would silently invent context, and could pass a snippet that
would fail for a real user pointing `archstone apply` at their own manifest.

Instead: a directory here per fixture name, holding exactly the surrounding files a snippet
needs. The fenced block in the doc says which one to use, explicitly:

````
```yaml archstone-fixture=tourism as=tourism.search.capability.yaml
capability:
  id: tourism.search
  ...
```
````

`scripts/verify-doc-snippets.mjs` copies this directory's files into a scratch temp dir,
writes the extracted snippet in alongside them at the given `as=` path, and runs `archstone
apply` against the result — the same compile pipeline `pnpm apply`/`archstone apply` always
runs, nothing bespoke.

A ` ```yaml ` block with no `archstone-fixture=` annotation is skipped — not every YAML block
in these docs is CDL (plenty are ASCII diagrams, JSON examples mislabeled, or fragments too
partial to usefully complete), and annotating is opt-in, not inferred.

## Fixtures

- **`tourism/`** — `capabilities.yaml` (declaring only `tourism.search` — see the file's own
  comment for why not the doc's full narrative list) + `tourism.Accommodation.resource.yaml` +
  `bindings/tourism.search.binding.yaml`, matching `docs/ONBOARDING.md`'s Provider Onboarding
  walkthrough (Steps 1, 3, 4) verbatim. Used to compile Step 2's `tourism.search` capability
  snippet — the same capability shown as "12 lines of business YAML" on the README homepage
  (there via a link to `examples/manifests/tourism/tourism.search.capability.yaml`, not an
  inline block, so nothing to annotate there directly; ONBOARDING.md's copy is the inline,
  copy-pasteable one this check protects).

Add a new directory here, named for its `archstone-fixture=<name>`, whenever a new doc snippet
needs one. Keep it to exactly what the snippet needs to resolve — no more.
