import { defineConfig } from "tsup";

export default defineConfig({
  // Four entries (ADD-37 R-2, extended by ADR-0012 D-6). `./verify` exists so `@archstone/init`
  // can reach `recordContract`/`runVerify` WITHOUT the root, whose index re-exports `serveStdio`
  // and therefore drags the MCP SDK into the importer's dependency closure. `./connector` exists
  // so `@archstone/agent`/`@archstone/cli`/`@archstone/init` can reach the centralized
  // `invokeConnector` dispatch WITHOUT the root either — that subpath imports `providers/sql`,
  // a `pg`-bearing, Node-only, TCP-opening package, and must never be reachable from `./http`
  // (the edge-safe subpath, D-5). Irrelevant for a Node CLI today; it matters the day the hosted
  // "point us at your spec" flow is built — and ADD-0008 already established the lesson this
  // encodes: a bundler can tree-shake an IMPORT, not a method. One `exports` entry now, not a
  // refactor later.
  entry: ["src/index.ts", "src/http.ts", "src/verify.ts", "src/connector.ts"],
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
