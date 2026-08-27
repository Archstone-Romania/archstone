// Flat ESLint config for the Archstone monorepo (pnpm workspace, ESM, TypeScript strict).
//
// Baseline ruleset (typescript-eslint "recommended", not type-checked): keeps `pnpm lint`
// clean today without requiring a wired-up `parserOptions.project` across every package's
// tsconfig. Tightening to `recommendedTypeChecked`/`strict` is a follow-up, not a blocker
// for the first public release (see issue #14).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.wrangler/**",
      "examples/manifests/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow `_foo`-prefixed unused args/vars — a common, intentional pattern in this
      // codebase (e.g. destructuring to drop a field, stub parameters).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain Node scripts (demo fixtures and the release tooling under scripts/, no tsconfig
    // coverage) — declare the Node globals they use so `no-undef` doesn't false-positive
    // outside the TS type-checked surface. The release tooling reached this workspace with
    // ADR-0010 (it used to live outside the linted tree entirely, which is why these were
    // never declared before): npm-readback talks to the registry over `fetch` with an
    // `AbortSignal` timeout, and both it and the gate pace retries with `setTimeout`.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
