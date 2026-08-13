#!/usr/bin/env node
// Verify doc snippets (#57) — published CDL is a second, unverified specification of the
// language. This compiles every fenced ```yaml block in the three docs where a copy-pasted
// snippet is most likely to rot (README.md, CASE-STUDY.md, docs/ONBOARDING.md) and fails the
// build if any of them do not compile.
//
// Mechanism: a doc snippet is deliberately partial (one capability, not the surrounding
// capabilities.yaml/resource/binding). A fenced block opts in to being checked by naming a
// FIXTURE DIRECTORY under examples/doc-fixtures/ that supplies exactly that surrounding
// context, plus the path to write the snippet itself at:
//
//   ```yaml archstone-fixture=tourism as=tourism.search.capability.yaml
//   capability:
//     ...
//   ```
//
// Explicit, not inferred (see examples/doc-fixtures/README.md for why) — a plain ```yaml
// block with no `archstone-fixture=` annotation is skipped: not every YAML block in these
// docs is CDL, and nothing here should guess.
//
// For each annotated block: copy the fixture directory into a scratch temp dir, write the
// extracted snippet in at its `as=` path, and run the SAME compiler pipeline `pnpm
// apply`/`archstone apply` always runs (`tsx packages/cli/src/index.ts apply <dir>`, in-repo
// — this is a docs check inside the workspace, not a packed-artifact release check; that's
// scripts/release-gate.mjs, one directory up, per #33). Fails (non-zero exit) if the compiler
// exits non-zero. A capability with no binding compiling with only a warning is an acceptable
// PASS (ADD-18) — this keys off the compiler's exit code, never warning text or count.
//
// Run from the archstone/ workspace root:
//
//   node scripts/verify-doc-snippets.mjs
//
// Exit 0 = every annotated snippet compiled (or no snippets were annotated at all — see
//          MIN_EXPECTED_BLOCKS below for why that alone is NOT good enough to pass).
// Exit 1 = at least one annotated snippet failed to compile, or the check found suspiciously
//          few annotated blocks to have actually exercised anything.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "examples", "doc-fixtures");
const CLI_ENTRY = join(ROOT, "packages", "cli", "src", "index.ts");

export const DOC_FILES = ["README.md", "CASE-STUDY.md", "docs/ONBOARDING.md"];

// A regression guard against the check going quietly toothless: if every annotation were
// stripped from the docs (accidentally, or by someone routing around a failure), extraction
// would find zero blocks and a naive "no failures" check would report a pass while verifying
// nothing at all. At least one annotated block is required for the run to count as a pass.
export const MIN_EXPECTED_BLOCKS = 1;

// ---------------------------------------------------------------------------------------
// Extraction (pure) — find fenced ```yaml blocks carrying an `archstone-fixture=` annotation.
// ---------------------------------------------------------------------------------------

// Matches a fenced block, any leading indentation (a fence can sit inside a numbered list
// item), language `yaml`, then the rest of the info string on the same line (annotations),
// then content up to a closing fence at the SAME indentation.
const FENCE_RE = /^([ \t]*)```ya?ml([^\n]*)\r?\n([\s\S]*?)\r?\n\1```[ \t]*$/gm;

/** Pure — parses `archstone-fixture=<name>` and `as=<path>` out of a fence's info string. */
export function parseAnnotations(infoRest) {
  const fixtureMatch = infoRest.match(/\barchstone-fixture=(\S+)/);
  const asMatch = infoRest.match(/\bas=(\S+)/);
  return {
    fixture: fixtureMatch ? fixtureMatch[1] : null,
    as: asMatch ? asMatch[1] : null,
  };
}

/**
 * Pure — extracts every ```yaml fenced block from markdown text, annotated or not (callers
 * filter). `startLine` is 1-indexed, pointing at the opening fence, for error messages.
 */
export function extractYamlBlocks(markdownText) {
  const blocks = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(markdownText))) {
    const [, indent, infoRest, content] = m;
    const startLine = markdownText.slice(0, m.index).split("\n").length;
    const { fixture, as } = parseAnnotations(infoRest);
    blocks.push({ indent, infoRest: infoRest.trim(), content, startLine, fixture, as });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------
// Compile one annotated block against its fixture.
// ---------------------------------------------------------------------------------------

/** Runs `archstone apply` (in-repo, tsx) against a directory. Returns {ok, output}. */
export function runApply(dir) {
  const res = spawnSync("pnpm", ["exec", "tsx", CLI_ENTRY, "apply", dir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const output = ((res.stdout || "") + (res.stderr || "")).trim();
  return { ok: res.status === 0, exitCode: res.status, output };
}

/**
 * Assembles one annotated block into a scratch dir (fixture files + the snippet at its `as=`
 * path) and compiles it. Returns a result record; never throws — a missing fixture or a
 * malformed annotation is reported as a failure like any compiler error, not an exception.
 */
export function checkBlock({ file, block }) {
  const label = `${file}:${block.startLine}`;

  if (!block.fixture) {
    return { file, startLine: block.startLine, skipped: true, reason: "no archstone-fixture= annotation" };
  }
  if (!block.as) {
    return {
      file,
      startLine: block.startLine,
      ok: false,
      detail: `${label}: block carries archstone-fixture=${block.fixture} but no as=<path> — every annotated ` +
        `block must say where its snippet gets written inside the fixture (e.g. as=tourism.search.capability.yaml).`,
    };
  }

  const fixtureDir = join(FIXTURES_DIR, block.fixture);
  if (!existsSync(fixtureDir)) {
    return {
      file,
      startLine: block.startLine,
      ok: false,
      detail: `${label}: archstone-fixture=${block.fixture} names a fixture directory that does not exist ` +
        `(expected ${relative(ROOT, fixtureDir)}). Add it under examples/doc-fixtures/, or fix the annotation.`,
    };
  }

  const scratch = mkdtempSync(join(tmpdir(), "archstone-doc-snippet-"));
  try {
    cpSync(fixtureDir, scratch, { recursive: true });
    const targetPath = join(scratch, block.as);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, block.content.endsWith("\n") ? block.content : block.content + "\n");

    const { ok, exitCode, output } = runApply(scratch);
    if (ok) {
      return { file, startLine: block.startLine, ok: true, fixture: block.fixture, as: block.as };
    }
    return {
      file,
      startLine: block.startLine,
      ok: false,
      fixture: block.fixture,
      as: block.as,
      detail:
        `${label}: snippet (fixture=${block.fixture}, as=${block.as}) failed \`archstone apply\` ` +
        `(exit ${exitCode}):\n${output.split("\n").map((l) => `      ${l}`).join("\n")}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

/**
 * Runs the whole check over the given files (paths relative to `root`). Returns
 * {results, checkedCount, failures} — pure given the filesystem, no process.exit, so it's
 * both the CLI entry point's engine and directly unit-testable.
 */
export function runCheck({ root = ROOT, files = DOC_FILES } = {}) {
  const results = [];
  for (const relPath of files) {
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) {
      results.push({ file: relPath, ok: false, detail: `${relPath}: file not found` });
      continue;
    }
    const text = readFileSync(absPath, "utf8");
    const blocks = extractYamlBlocks(text).filter((b) => b.fixture !== null);
    for (const block of blocks) {
      results.push(checkBlock({ file: relPath, block }));
    }
  }
  const checked = results.filter((r) => !r.skipped);
  const failures = checked.filter((r) => !r.ok);
  return { results, checkedCount: checked.length, failures };
}

function printReport({ results, checkedCount, failures }) {
  console.log(`\n[verify-doc-snippets] checked ${checkedCount} annotated CDL snippet(s):\n`);
  for (const r of results) {
    if (r.skipped) continue;
    const icon = r.ok ? "✓" : "✗";
    console.log(`  ${icon} ${r.file}:${r.startLine}${r.fixture ? `  (fixture=${r.fixture}, as=${r.as})` : ""}`);
  }
  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} snippet(s) failed to compile:\n`);
    for (const f of failures) {
      console.log(f.detail);
      console.log("");
    }
  }
  if (checkedCount < MIN_EXPECTED_BLOCKS) {
    console.log(
      `\n✗ only ${checkedCount} annotated snippet(s) found across ${DOC_FILES.join(", ")} — expected at least ` +
        `${MIN_EXPECTED_BLOCKS}. Either a snippet lost its archstone-fixture= annotation, or this check is no ` +
        `longer exercising anything.`,
    );
  }
  const passed = failures.length === 0 && checkedCount >= MIN_EXPECTED_BLOCKS;
  console.log(passed ? "\n✓ all published CDL snippets compile.\n" : "");
  return passed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = runCheck();
  const passed = printReport(outcome);
  process.exit(passed ? 0 : 1);
}
