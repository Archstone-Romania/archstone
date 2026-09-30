- **`archstone diff <before> <after> [--json] [--all]`: what changed for an agent between two
  declarations** (`@archstone/cli`, `@archstone/compiler`, ADD-309, #77). Each side is a built
  `archstone.ir.json` or a manifest directory compiled on the spot (an invalid one is refused
  with `apply`'s messages). Every change is classified `breaking`, `notable` or `compatible` by a
  fixed table: a removed capability, any `effect` change, a new required input, a removed or
  loosened output field, retirement or a narrower policy is breaking; deprecation, a wider
  policy, a rate-limit or policy-token change is notable; additions, descriptions and binding
  edits are compatible. A resource field change is reported once, on the resource, naming the
  capabilities it reaches. The command exits 1 iff anything is breaking, and 2 when it cannot
  compare (an unreadable side, or two different IR versions). The human report lists breaking
  and notable changes and counts compatible ones unless `--all`; `--json` prints the diff alone,
  with no aggregate `ok`. The comparison is `diffIR(before, after)`, pure and exported from
  `@archstone/compiler`. It never reads `contract`, so two built artifacts diff completely, and
  it says nothing about the backend: that is still `archstone verify`.
