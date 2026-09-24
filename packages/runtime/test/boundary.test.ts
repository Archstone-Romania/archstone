import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0012 D-5 guard: `server.ts` (shared by `serveStdio`, `http.ts`, and
// `examples/demo/remote-mcp-worker`, which imports the package ROOT directly for a Cloudflare
// Workers bundle) and `http.ts` (the edge-safe `/http` subpath) must NEVER statically reach
// `@archstone/provider-sql`/`pg` — a real, measured regression this test exists to catch
// mechanically (a `wrangler deploy --dry-run` against `examples/demo/remote-mcp-worker` grew the
// bundle by ~200 KiB before this fix, because `pg` does `require("net")`/`require("tls")`/
// `require("dns")` at module load time, not lazily).
//
// This walks the actual import GRAPH (relative imports only — a package specifier is a graph
// LEAF, checked against FORBIDDEN but never walked into, mirroring
// `packages/emitter-support/test/boundary.test.ts`), starting from `server.ts` and `http.ts`
// specifically — the two files the previous (broken) version of this guard did not check at
// all. `mcp.ts` (stdio) is a DIFFERENT case: it is Node-only and MAY carry a `connector`
// override injected by `@archstone/cli`, but it must not itself IMPORT the full dispatcher — see
// the third assertion below.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");

const FORBIDDEN: RegExp[] = [/^@archstone\/provider-sql/, /^pg$/];

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

function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined; // package specifier — a graph leaf
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function reachableFrom(entry: string): { files: Set<string>; violations: { file: string; spec: string }[] } {
  const files = new Set<string>();
  const violations: { file: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of collectImports(file)) {
      if (FORBIDDEN.some((re) => re.test(spec))) {
        violations.push({ file: file.slice(resolve(src, "..").length + 1), spec });
        continue;
      }
      const next = resolveRelative(file, spec);
      if (next) queue.push(next);
    }
  }
  return { files, violations };
}

describe("@archstone/runtime — server.ts/http.ts never reach pg/@archstone/provider-sql (ADR-0012 D-5)", () => {
  it("server.ts's import graph never reaches @archstone/provider-sql or pg", () => {
    const { violations } = reachableFrom(resolve(src, "server.ts"));
    expect(violations).toEqual([]);
  });

  it("http.ts's import graph never reaches @archstone/provider-sql or pg", () => {
    const { violations } = reachableFrom(resolve(src, "http.ts"));
    expect(violations).toEqual([]);
  });

  it("connector-rest.ts (the edge-safe dispatcher) never imports @archstone/provider-sql or pg", () => {
    const { violations } = reachableFrom(resolve(src, "connector-rest.ts"));
    expect(violations).toEqual([]);
  });

  it("mcp.ts (stdio) does not ITSELF import the full dispatcher — only a Node-only caller (the CLI) may inject it", () => {
    const specs = collectImports(resolve(src, "mcp.ts"));
    expect(specs).not.toContain("./connector");
  });

  // Sanity check that the walk itself is real (not vacuously passing because nothing resolved).
  it("server.ts's graph is non-trivial (more than just itself)", () => {
    const { files } = reachableFrom(resolve(src, "server.ts"));
    expect(files.size).toBeGreaterThan(1);
  });
});
