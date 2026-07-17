import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries, kept as separate output files (not bundled together) so subpath isolation
  // actually holds: a consumer importing only "./index" (the root) never has a build-time
  // edge into "./mcp" (ADD-0008 #29) or, transitively, @archstone/runtime/the MCP SDK.
  entry: ["src/index.ts", "src/mcp.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@archstone/compiler", "@archstone/emitter-support", "@archstone/provider-rest", "@archstone/runtime"],
});
