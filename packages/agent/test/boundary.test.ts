import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-1 guard (ADD-0008 #28, the DoD's hard gate): the root entry (src/index.ts and
// everything it TRANSITIVELY imports) must have ZERO reachability to
// @modelcontextprotocol/sdk — a bundler can only tree-shake dead imports, not dead method
// calls (ADD-0008's Architectural Challenge). Also guards R-2: no accidental re-import of
// @archstone/runtime's root (which would reintroduce the @archstone/schema/node:fs edge this
// package must not carry). Source-scan in the spirit of scripts/check-boundary.mjs and
// emitter-support/test/boundary.test.ts.
//
// #29 note: this walks the import GRAPH reachable from src/index.ts, not every file under
// src/ — src/mcp.ts (the new /mcp subpath, ADD-0008 #29) deliberately imports
// @archstone/runtime/http and is never imported by index.ts, so it must not appear in this
// graph. See the companion describe block below for the assertion that SDK reachability is
// isolated there, not absent from the package entirely.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");

const FORBIDDEN: RegExp[] = [
  /^@modelcontextprotocol\/sdk/,
  /^node:fs$/,
  /^node:path$/,
  /^@archstone\/runtime$/, // the root, schema/fs-coupled export — "/http" is a different subpath
];

const SPEC_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Resolve a relative import specifier (no extension, as TS source writes them) to an
 *  actual .ts file on disk. */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** BFS the import graph starting at `entry`, following only relative (in-package) imports —
 *  package specifiers (e.g. @archstone/emitter-support) are graph LEAVES, checked against
 *  FORBIDDEN but never walked into (a separate package's own boundary concern). */
function reachableFrom(entry: string): { files: Set<string>; violations: { file: string; spec: string }[] } {
  const files = new Set<string>();
  const violations: { file: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of collectImports(file)) {
      if (FORBIDDEN.some((re) => re.test(spec))) violations.push({ file: relative(file), spec });
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return { files, violations };
}

function relative(file: string): string {
  return file.slice(resolve(src, "..").length + 1);
}

describe("agent root entry — no MCP SDK / node:fs / node:path / @archstone/runtime reachable from src/index.ts", () => {
  it("no file transitively imported from index.ts references a forbidden specifier", () => {
    const { violations } = reachableFrom(resolve(src, "index.ts"));
    expect(violations).toEqual([]);
  });

  it("src/mcp.ts (the /mcp subpath) is not part of index.ts's import graph", () => {
    const { files } = reachableFrom(resolve(src, "index.ts"));
    expect([...files].some((f) => f.endsWith("/mcp.ts"))).toBe(false);
  });
});

describe("agent /mcp subpath — MCP SDK reachability is expected here, isolated from the root", () => {
  it("mcp.ts imports @archstone/runtime/http — the only file in src/ allowed to reach the MCP SDK", () => {
    const specs = collectImports(resolve(src, "mcp.ts"));
    expect(specs.some((s) => s === "@archstone/runtime/http")).toBe(true);
  });
});
