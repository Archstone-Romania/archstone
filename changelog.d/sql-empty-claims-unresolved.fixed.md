- **An `identityAdapter` returning claims that set no usable session GUC counted as a resolved
  identity.** In `@archstone/provider-sql`, `invokeSql` ran the declared query when the adapter
  returned an empty object `{}`, a claim with an empty-string or non-string value
  (`{ tenantId: "" }`, `{ tenantId: null }`), or a non-object result (a string, an array, or
  `Object` itself for the principal `constructor` in an `--identity-map`). In `@archstone/runtime`,
  `archstone verify`'s negative isolation test passed vacuously for the same negative-identity
  results, because RLS with no or an empty GUC returns zero rows. All of these now refuse exactly
  like an unresolved identity — "no session identity resolved" before any connection is used, and
  a red "negative identity did not resolve to any claims" in `verify` — which is the documented
  ADR-0012 D-3 contract.
