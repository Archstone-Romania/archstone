import { defineConfig } from "tsup";

// Two entries, deliberately (ADD-37 D-5 / R-2): the root is PURE (no fs, no HTTP, no
// terminal) and `loop` is the fs-touching one. They are separate entry points rather than
// one module with a side door, because a bundler can tree-shake an import, not a method —
// the same lesson the /http and /mcp subpaths already encode.
export default defineConfig({
  entry: ["src/index.ts", "src/loop.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["@archstone/schema", "@archstone/compiler", "@archstone/emitter-support", "@archstone/runtime"],
});
