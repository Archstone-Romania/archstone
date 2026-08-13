import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOC_FILES,
  MIN_EXPECTED_BLOCKS,
  parseAnnotations,
  extractYamlBlocks,
  checkBlock,
  runCheck,
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
