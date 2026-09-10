#!/usr/bin/env node
// Verify doc snippets (#57, widened by #29) — published CDL is a second, unverified
// specification of the language, and a published package README is a third: it ships to npm
// and can only be corrected by cutting a new version, unlike every other doc here, which is
// fixed by merging a PR. This file runs two independent checks:
//
// 1. CDL/YAML — compiles every fenced ```yaml block in the docs where a copy-pasted CDL
//    snippet is most likely to rot (README.md, CASE-STUDY.md, docs/ONBOARDING.md) and fails
//    the build if any of them do not compile.
//
//    Mechanism: a doc snippet is deliberately partial (one capability, not the surrounding
//    capabilities.yaml/resource/binding). A fenced block opts in to being checked by naming a
//    FIXTURE DIRECTORY under examples/doc-fixtures/ that supplies exactly that surrounding
//    context, plus the path to write the snippet itself at:
//
//      ```yaml archstone-fixture=tourism as=tourism.search.capability.yaml
//      capability:
//        ...
//      ```
//
//    Explicit, not inferred (see examples/doc-fixtures/README.md for why) — a plain ```yaml
//    block with no `archstone-fixture=` annotation is skipped: not every YAML block in these
//    docs is CDL, and nothing here should guess.
//
//    For each annotated block: copy the fixture directory into a scratch temp dir, write the
//    extracted snippet in at its `as=` path, and run the SAME compiler pipeline `pnpm
//    apply`/`archstone apply` always runs (`tsx packages/cli/src/index.ts apply <dir>`,
//    in-repo — this is a docs check inside the workspace, not a packed-artifact release
//    check; that's scripts/release-gate.mjs, one directory up, per #33). Fails (non-zero
//    exit) if the compiler exits non-zero. A capability with no binding compiling with only a
//    warning is an acceptable PASS (ADD-18) — this keys off the compiler's exit code, never
//    warning text or count.
//
// 2. TypeScript — every published package README (`packages/*/README.md`,
//    `providers/rest/README.md`; PACKAGE_README_FILES below discovers this list dynamically,
//    by presence of a README.md, rather than hardcoding it, so an added or removed package
//    changes coverage automatically) is exactly where the two failure modes #29 was filed
//    about actually happened: `packages/emitter-support`'s README once enumerated a substrate
//    list its own `index.ts` no longer matched, and `packages/agent`'s quick start once used
//    `fs` without importing it. Neither is a CDL/YAML problem, so mechanism 1 above cannot see
//    either — a second, TypeScript-shaped mechanism is required (#29's own "Possible shapes"
//    section weighed this; the option this repo took is the middle one: a real compile for
//    snippets that are real code, plus a cheap-but-real import/export check even for snippets
//    that are not).
//
//    Every fenced ```ts / ```typescript block in a package README is, by default, held to
//    being real, standalone, compilable TypeScript against the package's ACTUAL exports
//    (resolved from source via a `paths` map derived from every package.json's own `exports`
//    field — see buildArchstonePathsMap — never from what a README merely claims). A block
//    that is deliberately illustrative — a narrative continuation of an earlier block, or
//    pseudocode with placeholder names a reader is expected to substitute — opts out of the
//    full-compile bar with a `pseudocode` flag in the fence's info string:
//
//      ```typescript pseudocode
//      const result = stay.validate(modelOutput); // modelOutput: whatever you have
//      ```
//
//    A `pseudocode` block still isn't a free pass: if it imports from `@archstone/*`, that
//    import is checked against the real package on its own (a narrative aside is exactly
//    where a renamed export would otherwise hide unnoticed).
//
// Run from the archstone/ workspace root:
//
//   node scripts/verify-doc-snippets.mjs
//
// Exit 0 = every checked snippet passed (or no snippets were annotated/found at all — see
//          MIN_EXPECTED_BLOCKS/MIN_EXPECTED_TS_CHECKS below for why that alone is NOT good
//          enough to pass).
// Exit 1 = at least one checked snippet failed, or the check found suspiciously few blocks to
//          have actually exercised anything.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "examples", "doc-fixtures");
const CLI_ENTRY = join(ROOT, "packages", "cli", "src", "index.ts");

/**
 * Every published package/provider README, found by presence of a README.md under
 * `packages/*` and `providers/*` — a glob over the filesystem rather than a maintained list,
 * per #29, so a package added or removed later changes coverage without anyone remembering
 * to edit this file too.
 */
export function discoverPackageReadmes(root = ROOT) {
  const files = [];
  for (const groupDir of ["packages", "providers"]) {
    const base = join(root, groupDir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relPath = join(groupDir, entry.name, "README.md");
      if (existsSync(join(root, relPath))) files.push(relPath);
    }
  }
  return files.sort();
}

export const PACKAGE_README_FILES = discoverPackageReadmes();

export const DOC_FILES = ["README.md", "CASE-STUDY.md", "docs/ONBOARDING.md", ...PACKAGE_README_FILES];

// A regression guard against the check going quietly toothless: if every annotation were
// stripped from the docs (accidentally, or by someone routing around a failure), extraction
// would find zero blocks and a naive "no failures" check would report a pass while verifying
// nothing at all. At least one annotated block is required for the run to count as a pass.
export const MIN_EXPECTED_BLOCKS = 1;

// Same guard, for mechanism 2 — if every TypeScript block across the package READMEs were
// marked `pseudocode` with no `@archstone/*` import left to check, the check would silently
// verify nothing while still reporting a pass.
export const MIN_EXPECTED_TS_CHECKS = 1;

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
// TypeScript snippets in package READMEs (#29) — extraction (pure).
// ---------------------------------------------------------------------------------------

// Same shape as FENCE_RE, for ```ts / ```typescript fences instead of ```yaml.
const TS_FENCE_RE = /^([ \t]*)```(?:ts|typescript)([^\n]*)\r?\n([\s\S]*?)\r?\n\1```[ \t]*$/gm;

/** Pure — a fence opts OUT of the full-compile bar by carrying `pseudocode` in its info string
 *  (the opposite polarity from the YAML side's opt-IN `archstone-fixture=`: most TypeScript in
 *  a package README is real code and should default to checked; a YAML block is usually a
 *  deliberately partial fragment and should default to skipped). */
export function parseCodeAnnotations(infoRest) {
  return { pseudocode: /\bpseudocode\b/.test(infoRest) };
}

/** Pure — extracts every ```ts / ```typescript fenced block from markdown text. */
export function extractTypeScriptBlocks(markdownText) {
  const blocks = [];
  TS_FENCE_RE.lastIndex = 0;
  let m;
  while ((m = TS_FENCE_RE.exec(markdownText))) {
    const [, indent, infoRest, content] = m;
    const startLine = markdownText.slice(0, m.index).split("\n").length;
    const { pseudocode } = parseCodeAnnotations(infoRest);
    blocks.push({ indent, infoRest: infoRest.trim(), content, startLine, pseudocode });
  }
  return blocks;
}

/**
 * Pure — every `import ... from "@archstone/..."` in a snippet, with named-import bindings
 * (using the real exported name, not a local `as` alias — that's what has to exist on the
 * other side). Parsed with the real TypeScript parser rather than a regex, since imports are
 * exactly the syntax a regex is least trustworthy on (multi-line, aliasing, mixed default +
 * named forms).
 */
export function extractArchstoneImports(content) {
  const sourceFile = ts.createSourceFile("snippet.ts", content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imports = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    if (!specifier.startsWith("@archstone/")) continue;
    const names = [];
    const namedBindings = stmt.importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const el of namedBindings.elements) {
        names.push((el.propertyName ?? el.name).text);
      }
    }
    imports.push({ specifier, names });
  }
  return imports;
}

// ---------------------------------------------------------------------------------------
// TypeScript snippets — real type-checking against the real package sources.
// ---------------------------------------------------------------------------------------

/**
 * Every `@archstone/*` import specifier (root AND subpath, e.g. `@archstone/agent/mcp`) mapped
 * to the real source file that backs it — derived from each package's own `package.json`
 * "exports" field, never hand-maintained, so it cannot drift the way a README's prose claims
 * can. `exports["./mcp"].types` (`./dist/mcp.d.ts`) is rewritten to the in-repo source it is
 * built from (`./src/mcp.ts`) so this works against source, in-repo, the same way the YAML
 * mechanism runs the real compiler in-repo rather than against a packed artifact.
 */
export function buildArchstonePathsMap(root = ROOT) {
  const paths = {};
  for (const groupDir of ["packages", "providers"]) {
    const base = join(root, groupDir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const pkgJsonPath = join(dir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      } catch {
        continue; // malformed package.json is not this script's problem to report
      }
      const exportsMap = pkg.exports;
      if (!pkg.name || !exportsMap || typeof exportsMap !== "object") continue;
      for (const [subpath, target] of Object.entries(exportsMap)) {
        const specifier = subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`;
        const typesRel = typeof target === "object" && target !== null ? target.types : undefined;
        if (typeof typesRel !== "string") continue;
        const srcRel = typesRel.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$/, ".ts");
        const srcAbs = join(dir, srcRel);
        if (existsSync(srcAbs)) {
          paths[specifier] = [relative(root, srcAbs)];
        }
      }
    }
  }
  return paths;
}

/**
 * Type-checks `content` as a standalone TypeScript module, resolving `@archstone/*` against
 * real in-repo source via `pathsMap`. Returns the compiler's own diagnostics for that one
 * synthetic file — never throws, and never touches disk (the "file" is served to the compiler
 * host straight out of memory).
 */
export function typeCheckSnippet({ content, pathsMap, root = ROOT }) {
  const syntheticPath = join(root, "__doc-snippet-probe__.ts");
  const host = ts.createCompilerHost({});
  const realReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => (fileName === syntheticPath ? content : realReadFile(fileName));
  const realFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => (fileName === syntheticPath ? true : realFileExists(fileName));

  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(root, "node_modules", "@types")],
    baseUrl: root,
    paths: pathsMap,
  };

  const program = ts.createProgram([syntheticPath], compilerOptions, host);
  const sourceFile = program.getSourceFile(syntheticPath);
  return [...ts.getPreEmitDiagnostics(program, sourceFile)];
}

function formatCompileDiagnostics(diags, block) {
  return diags
    .map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file && d.start !== undefined) {
        // d.start is a position in the synthetic file, whose content is block.content
        // verbatim — the doc line is the fence's own line plus one (the fence itself) plus
        // the 0-indexed line the compiler reports within that content.
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return `      line ${block.startLine + 1 + line}: ${msg}`;
      }
      return `      ${msg}`;
    })
    .join("\n");
}

function formatProbeDiagnostics(diags) {
  return diags.map((d) => `      ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).join("\n");
}

/**
 * Checks one ```ts / ```typescript block from a package README. Returns an array of result
 * records (0, 1, or occasionally more) — never throws.
 *
 * - Not `pseudocode`: the whole block must compile standalone, against the real packages.
 *   This is what catches a snippet like the pre-#29 `packages/agent` quick start, which used
 *   `fs` without importing it — a real compile error, not an export-surface problem.
 * - `pseudocode`: the full-compile bar is waived (a narrative continuation legitimately
 *   references names a previous block defined, or a placeholder the reader is meant to
 *   substitute), but any `@archstone/*` import it makes is still checked on its own — this is
 *   what catches a snippet like the pre-#29 `packages/emitter-support` README, which named a
 *   substrate list its own `index.ts` no longer exported. A pseudocode block with no
 *   `@archstone/*` import has nothing left to check and is skipped, not passed.
 */
export function checkTypeScriptBlock({ file, block, pathsMap, root = ROOT }) {
  const label = `${file}:${block.startLine}`;
  const archstoneImports = extractArchstoneImports(block.content);

  if (block.pseudocode) {
    if (archstoneImports.length === 0) {
      return [
        {
          file,
          startLine: block.startLine,
          skipped: true,
          reason: "marked pseudocode, and no @archstone/* import to verify",
        },
      ];
    }
    const probe = archstoneImports
      .map(({ specifier, names }) =>
        names.length > 0
          ? `import { ${names.join(", ")} } from "${specifier}";\n${names.map((n) => `void ${n};`).join(" ")}`
          : `import "${specifier}";`,
      )
      .join("\n");
    const diags = typeCheckSnippet({ content: probe, pathsMap, root });
    if (diags.length === 0) {
      return [{ file, startLine: block.startLine, ok: true, kind: "ts-import-check" }];
    }
    return [
      {
        file,
        startLine: block.startLine,
        ok: false,
        kind: "ts-import-check",
        detail:
          `${label}: pseudocode block's @archstone/* import(s) do not match the real package's ` +
          `export surface:\n${formatProbeDiagnostics(diags)}`,
      },
    ];
  }

  const diags = typeCheckSnippet({ content: block.content, pathsMap, root });
  if (diags.length === 0) {
    return [{ file, startLine: block.startLine, ok: true, kind: "ts-compile" }];
  }
  return [
    {
      file,
      startLine: block.startLine,
      ok: false,
      kind: "ts-compile",
      detail:
        `${label}: snippet failed to type-check against the real package (mark the fence ` +
        `\`typescript pseudocode\` if it is deliberately illustrative rather than real, ` +
        `standalone code):\n${formatCompileDiagnostics(diags, block)}`,
    },
  ];
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

/**
 * Runs the whole check over the given files (paths relative to `root`). Returns
 * {results, checkedCount, tsCheckedCount, failures} — pure given the filesystem, no
 * process.exit, so it's both the CLI entry point's engine and directly unit-testable.
 *
 * The YAML/CDL mechanism runs over every file in `files`, as before. The TypeScript mechanism
 * additionally runs, but only over PACKAGE_README_FILES — README.md/CASE-STUDY.md/
 * docs/ONBOARDING.md already have their own, separately-scoped `pnpm build`/PR gate (#29's
 * own framing: everything except a package README is fixed by merging a PR), so widening the
 * TypeScript bar to their existing ```ts blocks is a different, not-yet-decided change, and
 * out of scope here.
 */
export function runCheck({ root = ROOT, files = DOC_FILES } = {}) {
  const results = [];
  let tsCheckedCount = 0;
  const pathsMap = buildArchstonePathsMap(root);
  for (const relPath of files) {
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) {
      results.push({ file: relPath, ok: false, detail: `${relPath}: file not found` });
      continue;
    }
    const text = readFileSync(absPath, "utf8");

    const yamlBlocks = extractYamlBlocks(text).filter((b) => b.fixture !== null);
    for (const block of yamlBlocks) {
      results.push(checkBlock({ file: relPath, block }));
    }

    if (PACKAGE_README_FILES.includes(relPath)) {
      const tsBlocks = extractTypeScriptBlocks(text);
      for (const block of tsBlocks) {
        for (const result of checkTypeScriptBlock({ file: relPath, block, pathsMap, root })) {
          results.push(result);
          if (!result.skipped) tsCheckedCount++;
        }
      }
    }
  }
  const checked = results.filter((r) => !r.skipped);
  const failures = checked.filter((r) => !r.ok);
  return { results, checkedCount: checked.length, tsCheckedCount, failures };
}

function printReport({ results, checkedCount, tsCheckedCount, failures }) {
  console.log(
    `\n[verify-doc-snippets] checked ${checkedCount} annotated snippet(s), ${tsCheckedCount} of them ` +
      `TypeScript:\n`,
  );
  for (const r of results) {
    if (r.skipped) continue;
    const icon = r.ok ? "✓" : "✗";
    const extra = r.fixture ? `  (fixture=${r.fixture}, as=${r.as})` : r.kind ? `  (${r.kind})` : "";
    console.log(`  ${icon} ${r.file}:${r.startLine}${extra}`);
  }
  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} snippet(s) failed:\n`);
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
  if (tsCheckedCount < MIN_EXPECTED_TS_CHECKS) {
    console.log(
      `\n✗ only ${tsCheckedCount} TypeScript snippet(s) checked across ${PACKAGE_README_FILES.join(", ")} — ` +
        `expected at least ${MIN_EXPECTED_TS_CHECKS}. Either every block was marked pseudocode with no ` +
        `@archstone/* import left to check, or this check is no longer exercising anything.`,
    );
  }
  const passed =
    failures.length === 0 && checkedCount >= MIN_EXPECTED_BLOCKS && tsCheckedCount >= MIN_EXPECTED_TS_CHECKS;
  console.log(passed ? "\n✓ all published CDL and package README snippets verified.\n" : "");
  return passed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = runCheck();
  const passed = printReport(outcome);
  process.exit(passed ? 0 : 1);
}
