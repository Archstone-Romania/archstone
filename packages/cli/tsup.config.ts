import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: false,
  sourcemap: true,
  clean: true,
  external: ["@archstone/schema", "@archstone/compiler", "@archstone/runtime"],
});
