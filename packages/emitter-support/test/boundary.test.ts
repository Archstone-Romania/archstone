import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-2 guard (ADD-0008 #27): emitter-support must stay MCP-SDK-free and fs-free so a consumer
// that imports only this package (or @archstone/agent's root entry, RFC-0008 #28) never gains
// a static edge to the MCP SDK or to disk I/O — a bundler can only tree-shake dead imports, not
// dead method calls (see the ADD's Architectural Challenge). Source-scan in the spirit of
// scripts/check-boundary.mjs, scoped to this package's own src/.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");

const FORBIDDEN: RegExp[] = [/^@modelcontextprotocol\/sdk/, /^node:fs$/, /^node:path$/];

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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("emitter-support — no MCP SDK / node:fs / node:path reachable from src/", () => {
  it("no source file imports @modelcontextprotocol/sdk, node:fs, or node:path", () => {
    const violations: { file: string; spec: string }[] = [];
    for (const file of walk(src)) {
      for (const spec of collectImports(file)) {
        if (FORBIDDEN.some((re) => re.test(spec))) violations.push({ file: relative(file), spec });
      }
    }
    expect(violations).toEqual([]);
  });

  // S-US2.6 / ADD-42 D-5 — the evaluator (#43) lives here and decides on a caller's identity,
  // which is exactly the pressure that would drag `providers/rest` in. It must not: the
  // principal arrives as a bare `string | undefined` on a small structural object, never as a
  // `CallerContext`. If this ever fails, the shared substrate has started knowing about HTTP.
  it("no source file imports @archstone/provider-rest (the evaluator takes a bare principal)", () => {
    const violations: { file: string; spec: string }[] = [];
    for (const file of walk(src)) {
      for (const spec of collectImports(file)) {
        if (/^@archstone\/provider-rest/.test(spec)) violations.push({ file: relative(file), spec });
      }
    }
    expect(violations).toEqual([]);
  });
});

function relative(file: string): string {
  return file.slice(resolve(src, "..").length + 1);
}
