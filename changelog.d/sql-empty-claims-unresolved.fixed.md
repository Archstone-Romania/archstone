- **An `identityAdapter` returning `{}` counted as a resolved identity.** In
  `@archstone/provider-sql`, `invokeSql` ran the declared query with no session GUC set when the
  adapter returned an empty claims object, and in `@archstone/runtime`, `archstone verify`'s
  negative isolation test passed vacuously when the negative identity resolved to `{}` (no GUC,
  so RLS returned zero rows). An empty claims object now refuses exactly like an unresolved one —
  "no session identity resolved" before any connection is used, and a red "negative identity did
  not resolve to any claims" in `verify` — which is the documented ADR-0012 D-3 contract.
