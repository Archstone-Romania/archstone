import { defineConfig } from "tsup";

export default defineConfig({
  // Five entries (ADD-37 R-2, extended by ADR-0012 D-5/D-6). `./verify` exists so
  // `@archstone/init` can reach `recordContract`/`runVerify` WITHOUT the root, whose index
  // re-exports `serveStdio` and therefore drags the MCP SDK into the importer's dependency
  // closure. `./connector` exists so `@archstone/cli`/`@archstone/init` can reach the FULL,
  // Node-only `invokeConnector` dispatch — that subpath imports `providers/sql`, a `pg`-bearing,
  // Node-only, TCP-opening package, and must NEVER be reachable from `./http`, `./connector-rest`,
  // or the package root (all three are — or are reachable from — an edge-safe surface, per a
  // measured `wrangler deploy --dry-run` against `examples/demo/remote-mcp-worker`). `./connector-
  // rest` is the edge-safe default `@archstone/agent`'s `execute()` uses (and the one `server.ts`/
  // `http.ts` use internally) — published as its own subpath so an embedder can name its
  // `InvokeOptions`/`ConnectorDispatch` types without pulling in the full dispatcher. ADD-0008
  // already established the lesson this encodes: a bundler can tree-shake an IMPORT, not a
  // method. One `exports` entry per boundary, not a refactor later.
  entry: ["src/index.ts", "src/http.ts", "src/verify.ts", "src/connector.ts", "src/connector-rest.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@archstone/schema",
    "@archstone/compiler",
    "@archstone/emitter-support",
    "@archstone/provider-rest",
    "@archstone/provider-sql",
  ],
});
