import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// R-2 follow-up (ADD-0008 #27 review, NF-3): http.ts + server.ts must stay reachable without
// the fs edge (./registry's buildRegistry / @archstone/schema `load()`) or node:fs/node:path —
// @archstone/agent's mcpHandler() (#29) depends on this property holding. Scoped to these two
// files only (unlike emitter-support's package-wide scan) because the rest of runtime/src
// (registry.ts, verify.ts, mcp.ts's serveStdio) legitimately needs the fs edge for disk-backed
// commands — only the /http subpath's own module graph must avoid it.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const FILES = ["http.ts", "server.ts"];
const FORBIDDEN: RegExp[] = [/^\.\/registry$/, /^@archstone\/schema/, /^node:fs$/, /^node:path$/];

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

describe("runtime/http — no fs edge (./registry, @archstone/schema, node:fs, node:path) reachable", () => {
  it("http.ts and server.ts import neither the disk-backed Registry builder nor node:fs/node:path", () => {
    const violations: { file: string; spec: string }[] = [];
    for (const name of FILES) {
      for (const spec of collectImports(resolve(src, name))) {
        if (FORBIDDEN.some((re) => re.test(spec))) violations.push({ file: name, spec });
      }
    }
    expect(violations).toEqual([]);
  });
});
