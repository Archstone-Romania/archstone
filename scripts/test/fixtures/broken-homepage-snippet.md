<!--
Regression fixture (dev-57). This reproduces, verbatim, the flattened pseudo-syntax that shipped
on the archstone.dev homepage until it was caught by hand on 2026-07-30 — never a valid CDL
shape, but nothing compiled it, so nothing said so. See scripts/verify-doc-snippets.test.ts:
this file exists so the check's regression test runs against a REAL fenced block extracted the
same way the real docs are, rather than an inline string in the test file.
-->

# Regression: pre-fix homepage snippet (must be REJECTED)

```yaml archstone-fixture=tourism as=tourism.search.capability.yaml
capability: tourism.search          # capability is a mapping, not a scalar
input:
  destination: location             # a field is { type: location }
output:
  stays: collection<Stay>           # no angle-bracket generics in CDL
```
