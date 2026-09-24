// @archstone/runtime — Capability Registry (#5) + MCP emitter (#7)
//
// ADR-0012 D-5 (found reviewing the SQL provider): this root used to `export * from "./verify"`.
// `verify.ts` now imports the FULL, `pg`-bearing connector dispatch (it must — replaying a `sql`
// binding's contract needs `invokeSql`), and `examples/demo/remote-mcp-worker` imports THIS root
// directly for its Cloudflare Workers bundle. Re-exporting `verify.ts` here made `pg` reachable
// from the root regardless of whether a consumer ever calls `runVerify`/`recordContract` — a
// bare, unconditional side-effecting import in the compiled bundle, not something a downstream
// bundler's tree-shaking can remove (confirmed via `wrangler deploy --dry-run`). `verify.ts` was
// ALREADY published as its own subpath for exactly this shape of reason (ADD-37 R-2 — "a bundler
// can tree-shake an IMPORT, not a method"); this root simply stops ALSO re-exporting it.
// `@archstone/cli` (`adopt.ts`, `index.ts`) now imports `@archstone/runtime/verify` directly —
// see `packages/runtime/test/boundary.test.ts` for the regression test.
export * from "./registry";
export * from "./mcp";
export * from "./mapping";
export * from "./adopt";
export * from "./audit-file";
