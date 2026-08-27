<!--
Regression fixture (dev-57) — the corrected, compiling counterpart to
broken-homepage-snippet.md in this same directory. Real flow-mapping CDL (a field is
`{ type: ... }`, not a bare type name; a collection output is `collection: <ResourceName>`,
not `collection<ResourceName>`), same shape as docs/ONBOARDING.md's own Step 2 snippet and the
hand-corrected homepage example this issue was filed about.
-->

# Regression: corrected snippet (must PASS)

```yaml archstone-fixture=tourism as=tourism.search.capability.yaml
capability:
  id: tourism.search
  description: Find accommodation matching customer preferences.
  effect: read

  input:
    destination: { type: location }
    dates:       { type: date-range }
    travelers:   { type: party }

  output:
    accommodations:
      collection: Accommodation

  provider: booking-api
```
