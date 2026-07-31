import { defineConfig } from "tsup";

export default defineConfig({
  // Three entries (ADD-37 R-2). `./verify` exists so `@archstone/init` can reach
  // `recordContract`/`runVerify` WITHOUT the root, whose index re-exports `serveStdio` and
  // therefore drags the MCP SDK into the importer's dependency closure. Irrelevant for a Node
  // CLI today; it matters the day the hosted "point us at your spec" flow is built — and
  // ADD-0008 already established the lesson this encodes: a bundler can tree-shake an IMPORT,
  // not a method. One `exports` entry now, not a refactor later.
  entry: ["src/index.ts", "src/http.ts", "src/verify.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@archstone/schema", "@archstone/compiler", "@archstone/emitter-support", "@archstone/provider-rest"],
});
