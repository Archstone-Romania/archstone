import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_FILES,
  PACKAGE_README_FILES,
  MIN_EXPECTED_BLOCKS,
  MIN_EXPECTED_TS_CHECKS,
  parseAnnotations,
  extractYamlBlocks,
  checkBlock,
  runCheck,
  discoverPackageReadmes,
  parseCodeAnnotations,
  extractTypeScriptBlocks,
  extractArchstoneImports,
  buildArchstonePathsMap,
  typeCheckSnippet,
  checkTypeScriptBlock,
} from "./verify-doc-snippets.mjs";

// Regression coverage for #57 — published CDL snippets are unverified. On 2026-07-30 a
// flattened pseudo-syntax shipped on the archstone.dev homepage (`capability:` as a scalar,
// `destination: location` shorthand, `stays: collection<Stay>` generics) and nothing caught
// it. These tests prove the fixture-directory mechanism actually rejects that shape and
// accepts its corrected counterpart — not just that the script runs.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIXTURES_DIR = resolve(HERE, "test", "fixtures");

describe("parseAnnotations", () => {
  it("extracts archstone-fixture= and as= from a fence info string", () => {
    expect(parseAnnotations(" archstone-fixture=tourism as=tourism.search.capability.yaml")).toEqual({
      fixture: "tourism",
      as: "tourism.search.capability.yaml",
    });
  });

  it("returns nulls for a plain ```yaml block with no annotation", () => {
    expect(parseAnnotations("")).toEqual({ fixture: null, as: null });
  });

  it("is order-independent", () => {
    expect(parseAnnotations(" as=x.capability.yaml archstone-fixture=tourism")).toEqual({
      fixture: "tourism",
      as: "x.capability.yaml",
    });
  });
});

describe("extractYamlBlocks", () => {
  it("finds an annotated block and captures its content and 1-indexed start line", () => {
    const md = [
      "# heading",
      "",
      "```yaml archstone-fixture=tourism as=x.capability.yaml",
      "capability:",
      "  id: x",
      "```",
      "",
    ].join("\n");
    const blocks = extractYamlBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].fixture).toBe("tourism");
    expect(blocks[0].as).toBe("x.capability.yaml");
    expect(blocks[0].content).toBe("capability:\n  id: x");
  });

  it("skips a plain ```yaml block with no annotation (not every yaml block is CDL)", () => {
    const md = ["```yaml", "just: some yaml", "```"].join("\n");
    const blocks = extractYamlBlocks(md).filter((b) => b.fixture !== null);
    expect(blocks).toHaveLength(0);
  });

  it("ignores non-yaml fences entirely", () => {
    const md = ["```bash", "echo hi", "```"].join("\n");
    expect(extractYamlBlocks(md)).toHaveLength(0);
  });

  it("matches an indented fence (inside a numbered list item) without mangling its content", () => {
    // Content is captured verbatim, including the list item's own indentation — the compiler
    // is fine with YAML that carries a uniform leading margin, and stripping it here would be
    // one more place this script could get a real doc's whitespace subtly wrong.
    const md = ["1. step one:", "   ```yaml archstone-fixture=tourism as=x.capability.yaml", "   capability:", "     id: x", "   ```"].join(
      "\n",
    );
    const blocks = extractYamlBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("   capability:\n     id: x");
  });
});

describe("checkBlock — the regression this issue was filed about", () => {
  const brokenMd = readFileSync(resolve(FIXTURES_DIR, "broken-homepage-snippet.md"), "utf8");
  const workingMd = readFileSync(resolve(FIXTURES_DIR, "working-homepage-snippet.md"), "utf8");

  it("REJECTS the pre-fix flattened pseudo-syntax (capability: as scalar, bare field types, <> generics)", () => {
    const [block] = extractYamlBlocks(brokenMd).filter((b) => b.fixture !== null);
    expect(block).toBeDefined();
    const result = checkBlock({ file: "regression/broken-homepage-snippet.md", block });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("archstone apply");
  }, 30_000);

  it("PASSES the corrected flow-mapping form of the same capability", () => {
    const [block] = extractYamlBlocks(workingMd).filter((b) => b.fixture !== null);
    expect(block).toBeDefined();
    const result = checkBlock({ file: "regression/working-homepage-snippet.md", block });
    expect(result.ok).toBe(true);
  }, 30_000);
});

describe("checkBlock — fixture-mechanism edge cases", () => {
  it("fails closed, naming the problem, when archstone-fixture= names a directory that does not exist", () => {
    const block = { startLine: 1, content: "capability:\n  id: x\n", fixture: "does-not-exist", as: "x.capability.yaml" };
    const result = checkBlock({ file: "some.md", block });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("does-not-exist");
    expect(result.detail).toContain("does not exist");
  });

  it("fails closed, naming the problem, when a fixture is given with no as=", () => {
    const block = { startLine: 1, content: "capability:\n  id: x\n", fixture: "tourism", as: null };
    const result = checkBlock({ file: "some.md", block });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("as=<path>");
  });

  it("is skipped, not failed, when the block carries no archstone-fixture= at all", () => {
    const block = { startLine: 1, content: "just: yaml\n", fixture: null, as: null };
    const result = checkBlock({ file: "some.md", block });
    expect(result.skipped).toBe(true);
  });
});

describe("runCheck — the real published docs, today", () => {
  it("finds at least one annotated snippet and every one of them compiles", () => {
    const outcome = runCheck({ root: ROOT, files: DOC_FILES });
    expect(outcome.checkedCount).toBeGreaterThanOrEqual(MIN_EXPECTED_BLOCKS);
    expect(outcome.failures).toEqual([]);
  }, 30_000);

  it("reports a missing doc file as a failure rather than throwing", () => {
    const outcome = runCheck({ root: ROOT, files: ["does-not-exist.md"] });
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].detail).toContain("not found");
  });
});

// Regression coverage for #29 — the eight published package READMEs (packages/*/README.md,
// providers/rest/README.md) were not covered by anything: neither this script (```yaml-only)
// nor any other check. Two real, live bugs were found and fixed by this same change:
// `packages/agent/README.md`'s quick start used `fs` without importing it, and its import line
// claimed `tools`/`execute` as named exports of `@archstone/agent`, which they are not (they
// are methods on the object `fromIR()` returns). These tests prove the mechanism that catches
// both, not just that the script runs.

describe("discoverPackageReadmes / PACKAGE_README_FILES", () => {
  it("finds a README.md for every package and provider directory that has one, sorted", () => {
    const files = discoverPackageReadmes(ROOT);
    expect(files).toContain("packages/agent/README.md");
    expect(files).toContain("packages/cli/README.md");
    expect(files).toContain("providers/rest/README.md");
    expect(files).toEqual([...files].sort());
  });

  it("is exactly what DOC_FILES appends to the three top-level docs", () => {
    expect(DOC_FILES).toEqual(["README.md", "CASE-STUDY.md", "docs/ONBOARDING.md", ...PACKAGE_README_FILES]);
  });
});

describe("parseCodeAnnotations", () => {
  it("recognizes a `pseudocode` flag in the fence info string", () => {
    expect(parseCodeAnnotations(" pseudocode")).toEqual({ pseudocode: true });
  });

  it("defaults to checked (not pseudocode) for a plain ```typescript fence", () => {
    expect(parseCodeAnnotations("")).toEqual({ pseudocode: false });
  });
});

describe("extractTypeScriptBlocks", () => {
  it("finds a ```typescript block and captures its pseudocode flag and 1-indexed start line", () => {
    const md = ["# heading", "", "```typescript pseudocode", "const x = 1;", "```", ""].join("\n");
    const blocks = extractTypeScriptBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].pseudocode).toBe(true);
    expect(blocks[0].content).toBe("const x = 1;");
  });

  it("also matches the ```ts spelling", () => {
    const md = ["```ts", "const x = 1;", "```"].join("\n");
    expect(extractTypeScriptBlocks(md)).toHaveLength(1);
  });

  it("ignores non-ts/typescript fences entirely", () => {
    const md = ["```yaml", "a: 1", "```"].join("\n");
    expect(extractTypeScriptBlocks(md)).toHaveLength(0);
  });
});

describe("extractArchstoneImports", () => {
  it("collects named imports from an @archstone/* specifier, using the real name over a local alias", () => {
    const content = 'import { fromIR, tools as t } from "@archstone/agent";';
    expect(extractArchstoneImports(content)).toEqual([{ specifier: "@archstone/agent", names: ["fromIR", "tools"] }]);
  });

  it("ignores imports from non-@archstone specifiers", () => {
    expect(extractArchstoneImports('import { readFileSync } from "node:fs";')).toEqual([]);
  });

  it("captures a subpath specifier (e.g. @archstone/agent/mcp) as its own entry", () => {
    const content = 'import { mcpHandler } from "@archstone/agent/mcp";';
    expect(extractArchstoneImports(content)).toEqual([{ specifier: "@archstone/agent/mcp", names: ["mcpHandler"] }]);
  });

  it("returns an empty names list for a side-effect-only import", () => {
    expect(extractArchstoneImports('import "@archstone/agent";')).toEqual([
      { specifier: "@archstone/agent", names: [] },
    ]);
  });
});

describe("buildArchstonePathsMap", () => {
  const pathsMap = buildArchstonePathsMap(ROOT);

  it("maps every package's root export to its real, in-repo source file", () => {
    expect(pathsMap["@archstone/agent"]).toEqual(["packages/agent/src/index.ts"]);
    expect(pathsMap["@archstone/provider-rest"]).toEqual(["providers/rest/src/index.ts"]);
  });

  it("maps a subpath export (package.json's exports[\"./mcp\"]) to its own source file, not just the root", () => {
    expect(pathsMap["@archstone/agent/mcp"]).toEqual(["packages/agent/src/mcp.ts"]);
  });
});

describe("typeCheckSnippet", () => {
  const pathsMap = buildArchstonePathsMap(ROOT);

  it("reports no diagnostics for a snippet that imports a real export correctly", () => {
    const diags = typeCheckSnippet({
      content: 'import { fromIR } from "@archstone/agent";\nvoid fromIR;',
      pathsMap,
      root: ROOT,
    });
    expect(diags).toHaveLength(0);
  });

  it("reports a diagnostic for a name the package does not export (the emitter-support-README regression)", () => {
    const diags = typeCheckSnippet({
      content: 'import { thisIsNotReal } from "@archstone/agent";\nvoid thisIsNotReal;',
      pathsMap,
      root: ROOT,
    });
    expect(diags.length).toBeGreaterThan(0);
  });

  it("reports a diagnostic for a Node builtin used without an import (the agent-README `fs` regression)", () => {
    const diags = typeCheckSnippet({ content: 'const x = fs.readFileSync("y");', pathsMap, root: ROOT });
    expect(diags.length).toBeGreaterThan(0);
  });
}, 30_000);

describe("checkTypeScriptBlock", () => {
  const pathsMap = buildArchstonePathsMap(ROOT);

  it("PASSES a self-contained, non-pseudocode block that compiles against the real package", () => {
    const block = {
      startLine: 1,
      pseudocode: false,
      content: 'import { fromIR } from "@archstone/agent";\nvoid fromIR;',
    };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ts-compile");
  });

  it("FAILS a non-pseudocode block that uses a Node builtin without importing it", () => {
    const block = { startLine: 1, pseudocode: false, content: 'const x = fs.readFileSync("y");' };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("pseudocode");
  });

  it("FAILS a non-pseudocode block whose import claims an export the package does not have", () => {
    const block = {
      startLine: 1,
      pseudocode: false,
      content: 'import { tools } from "@archstone/agent";\nvoid tools;',
    };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("ts-compile");
  });

  it("skips (not passes) a pseudocode block with no @archstone/* import to verify", () => {
    const block = { startLine: 1, pseudocode: true, content: "const modelOutput = whatever();" };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.skipped).toBe(true);
  });

  it("still checks a pseudocode block's @archstone/* import against the real export surface", () => {
    const block = {
      startLine: 1,
      pseudocode: true,
      content: 'import { mcpHandler } from "@archstone/agent/mcp";\nconst h = mcpHandler(archstone, opts);',
    };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("ts-import-check");
  });

  it("FAILS a pseudocode block whose import names something the package does not export", () => {
    const block = {
      startLine: 1,
      pseudocode: true,
      content: 'import { notReallyExported } from "@archstone/agent/mcp";',
    };
    const [result] = checkTypeScriptBlock({ file: "some/README.md", block, pathsMap, root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("ts-import-check");
  });
}, 30_000);

describe("runCheck — package README TypeScript coverage, today", () => {
  it("checks at least MIN_EXPECTED_TS_CHECKS TypeScript snippets across the package READMEs, all passing", () => {
    const outcome = runCheck({ root: ROOT, files: DOC_FILES });
    expect(outcome.tsCheckedCount).toBeGreaterThanOrEqual(MIN_EXPECTED_TS_CHECKS);
    expect(outcome.failures).toEqual([]);
  }, 30_000);
});
