- **`archstone verify` could never pass a `sql` binding.** The CLI builds an `identityAdapter`
  from `--identity-map` / `ARCHSTONE_IDENTITY_MAP` but has no caller principal to resolve through
  it, so the positive replay in `@archstone/runtime`'s `verifyTool` refused with "no session
  identity resolved" and every contract-bearing `sql` binding was red. A golden fixture may now
  record `identity: { principal }` beside `negativeIdentity`; for a `sql` binding with no caller
  principal, the positive leg replays under that principal (ADR-0012 D-8). A caller principal
  supplied by an embedding host still wins, `rest` bindings ignore the field, and a fixture
  without it behaves exactly as before.
