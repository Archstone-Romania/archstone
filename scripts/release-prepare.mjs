// Stamp the repository for a release: every publishable package.json, the root
// package.json, server.json, and the CHANGELOG heading.
//
// This is the half of the release that release.yml deliberately does NOT do. That workflow
// VERIFIES the tagged commit is stamped and refuses to publish otherwise (see its "Assert
// the tagged commit is stamped" step) — main is protected, and the tag is the single source
// of what ships, so nothing may push a bump commit from inside the release. The stamping
// therefore has to happen earlier, in a reviewed PR, and until now it happened by hand:
// eleven version strings across ten files, checked by three separate gates, where one miss
// means a deleted tag and a re-tag.
//
// What it does NOT do, on purpose:
//
//   - It does not commit, push, tag, or open a PR. It edits the working tree and prints what
//     it changed. The workflow around it owns git; a human owns the PR and the tag.
//   - It does not decide the version. `--bump` computes a candidate from the root
//     package.json, but the caller passes the final string, so the version that reaches the
//     files is always one someone typed or read.
//   - It does not write release notes. They are authored as the work lands, one file per
//     change under `changelog.d/` (see foldFragments), so that two PRs never edit the same
//     lines of CHANGELOG.md. This folds those files into `[Unreleased]`, renames the heading
//     and opens a fresh empty section above it.
//
// The package set is DISCOVERED (`private: false` under packages/ and providers/), never
// listed here. release-gate.mjs already asserts that discovered set is exactly what
// release.yml stamps and publishes, so discovery is what keeps this script from drifting
// away from the gate that will judge its output. A hardcoded list here would be a fourth
// place to forget a new package.

import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(v) {
  const m = SEMVER.exec(v ?? "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compute the next version from a current one. Used only to SUGGEST a version for the
 * workflow's `bump` input; the stamping itself always takes an explicit string.
 */
export function nextVersion(current, bump) {
  const c = parseVersion(current);
  if (!c) throw new Error(`current version is not semver: "${current}"`);
  switch (bump) {
    case "major":
      return `${c.major + 1}.0.0`;
    case "minor":
      return `${c.major}.${c.minor + 1}.0`;
    case "patch":
      return `${c.major}.${c.minor}.${c.patch + 1}`;
    default:
      throw new Error(`unknown bump "${bump}" (expected major, minor or patch)`);
  }
}

/**
 * Every workspace package that release.yml stamps and publishes: `private: false` under
 * packages/ or providers/. Deliberately the same rule as release-gate.mjs — see the header.
 */
export function discoverPublishablePackages(root = ROOT) {
  const found = [];
  for (const group of ["packages", "providers"]) {
    let entries;
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const rel = `${group}/${e.name}/package.json`;
      const abs = join(root, rel);
      if (!existsSync(abs)) continue;
      if (JSON.parse(readFileSync(abs, "utf8")).private === false) found.push(rel);
    }
  }
  return found.sort();
}

/**
 * Rewrite only the top-level "version" of a package.json, in place, as text.
 *
 * Text and not JSON.stringify: re-serialising would reformat the whole file — key order is
 * preserved by V8 but indentation, blank lines and the trailing newline are not — turning a
 * one-line release diff into a whole-file diff that no reviewer can read. The anchor is the
 * first `"version":` at one indent level, which is the top-level one; a nested
 * `devEngines.packageManager.version` sits deeper and is left alone.
 */
export function stampPackageJson(text, version) {
  const re = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  if (!re.test(text)) throw new Error('no top-level "version" field found');
  return text.replace(re, `$1${version}$3`);
}

/**
 * server.json (the MCP Registry manifest) carries the version TWICE — once at the root and
 * once per entry in `packages[]` — and is not an npm package, so nothing in the publish path
 * would notice it drifting. release-gate.mjs's checkServerManifestVersion is what catches
 * that; this is what keeps it quiet.
 */
export function stampServerJson(text, version) {
  const before = JSON.parse(text);
  const expected = 1 + (Array.isArray(before.packages) ? before.packages.length : 0);
  let n = 0;
  const out = text.replace(/^(\s*"version"\s*:\s*")([^"]*)(")/gm, (_, a, __, c) => {
    n += 1;
    return `${a}${version}${c}`;
  });
  if (n !== expected) {
    throw new Error(
      `server.json: expected ${expected} version fields (1 root + ${expected - 1} in packages[]), ` +
        `rewrote ${n}. The manifest's shape changed — update this script rather than shipping a ` +
        `half-stamped registry manifest.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// changelog.d — one file per change, folded in at release time.
//
// Every PR used to add its entry under `## [Unreleased]`, at the top of the same `### Fixed`
// list, so almost every merge left every other open PR in conflict on CHANGELOG.md. A file
// per change cannot conflict: two PRs add two different files. The cost is moved to one
// place, the release-prepare PR, where the files are folded into the CHANGELOG and deleted.
//
// A fragment is `changelog.d/<anything>.<category>.md`. The category is in the name rather
// than in a heading inside the file so a misfiled entry is visible in the PR's file list,
// and so a file cannot open a section the CHANGELOG does not use. The body is the entry
// exactly as it should read under that `### Category` heading, usually one `- **…**` bullet.
// ---------------------------------------------------------------------------------------

/** Keep a Changelog's categories, in the order a section lists them. */
export const FRAGMENT_CATEGORIES = ["added", "changed", "deprecated", "removed", "fixed", "security"];

const FRAGMENT_DIR = "changelog.d";
const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._-]*\.([a-z]+)\.md$/;

/**
 * Read every fragment under `changelog.d/`, sorted by file name so the folded order is the
 * same on every machine. Throws on a file it cannot place, naming it: a fragment that is
 * silently skipped is a change that ships with no release note. `README.md` is the
 * directory's own documentation, not a fragment.
 */
export function readFragments(root = ROOT) {
  const dir = join(root, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  const fragments = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "README.md") continue;
    const rel = `${FRAGMENT_DIR}/${name}`;
    const m = FRAGMENT_NAME.exec(name);
    if (!m || !FRAGMENT_CATEGORIES.includes(m[1])) {
      throw new Error(
        `${rel}: a fragment is named <slug>.<category>.md, with category one of ` +
          `${FRAGMENT_CATEGORIES.join(", ")}`,
      );
    }
    const body = readFileSync(join(dir, name), "utf8").trim();
    if (body === "") throw new Error(`${rel} is empty — it would fold in as a blank entry`);
    if (/^#{1,3} /m.test(body)) {
      throw new Error(
        `${rel} contains a #, ## or ### heading — the category comes from the file name, and ` +
          `a heading inside the entry would break the CHANGELOG's section structure`,
      );
    }
    fragments.push({ rel, category: m[1], body });
  }
  return fragments;
}

const titleOf = (category) => category[0].toUpperCase() + category.slice(1);

/**
 * Fold fragments into the `## [Unreleased]` section, under the matching `### Category`
 * heading, after whatever entries that heading already has. A category the section does not
 * have yet is opened after the existing ones, in Keep a Changelog order. Entries already
 * under `[Unreleased]` are kept exactly as they are, so a hand-written entry and a fragment
 * can coexist.
 */
export function foldFragments(text, fragments) {
  if (fragments.length === 0) return text;
  const idx = text.indexOf("## [Unreleased]");
  if (idx === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] section");

  const start = idx + "## [Unreleased]".length;
  const rest = text.slice(start);
  const next = rest.search(/^## \[/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  const tail = next === -1 ? "" : rest.slice(next);

  // Split the section into its text before the first ### heading and its ### subsections.
  const parts = body.split(/^(?=### )/m);
  const preamble = parts[0].startsWith("### ") ? "" : parts.shift();
  const sections = parts.map((p) => {
    const nl = p.indexOf("\n");
    const heading = nl === -1 ? p : p.slice(0, nl);
    return { title: heading.slice(4).trim(), content: nl === -1 ? "" : p.slice(nl + 1) };
  });

  for (const category of FRAGMENT_CATEGORIES) {
    const entries = fragments.filter((f) => f.category === category).map((f) => f.body);
    if (entries.length === 0) continue;
    let section = sections.find((s) => s.title.toLowerCase() === category);
    if (!section) {
      section = { title: titleOf(category), content: "" };
      sections.push(section);
    }
    const existing = section.content.trim();
    section.content = [existing, ...entries].filter(Boolean).join("\n\n");
  }

  const rendered = sections.map((s) => `### ${s.title}\n\n${s.content.trim()}\n`).join("\n");
  const lead = preamble.trim() === "" ? "\n\n" : `${preamble.trimEnd()}\n\n`;
  return `${text.slice(0, start)}${lead}${rendered}${tail === "" ? "" : `\n${tail}`}`;
}

/**
 * Turn `## [Unreleased]` into `## [X.Y.Z]` and open a fresh, empty `## [Unreleased]` above
 * it. release.yml reads the `## [X.Y.Z]` section verbatim as the GitHub Release body and
 * fails the release if it is empty, so an Unreleased section with no entries under it is a
 * release with nothing to announce — refuse here, where it costs a re-run rather than a
 * deleted tag.
 */
export function stampChangelog(text, version) {
  if (text.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const idx = text.indexOf("## [Unreleased]");
  if (idx === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] section");

  const after = text.slice(idx + "## [Unreleased]".length);
  const body = after.split(/^## \[/m)[0];
  if (body.trim() === "") {
    throw new Error(
      "CHANGELOG.md's [Unreleased] section is empty — there is nothing to release. " +
        "release.yml uses this section as the GitHub Release body and refuses an empty one.",
    );
  }

  return `${text.slice(0, idx)}## [Unreleased]\n\n## [${version}]${after}`;
}

function relPathsFor(root) {
  return ["package.json", ...discoverPublishablePackages(root)];
}

/**
 * Stamp the whole tree. Returns the list of files changed, for the caller to report.
 *
 * Every file is read and rewritten in memory FIRST, and only written once all of them
 * succeeded: a throw halfway through would otherwise leave the tree stamped in part, which
 * is the exact state the release gate exists to catch and the worst one to hand a reviewer.
 */
export function stampTree(version, root = ROOT) {
  if (!parseVersion(version)) {
    throw new Error(`version must be X.Y.Z with no leading "v": got "${version}"`);
  }

  const pending = [];

  for (const rel of relPathsFor(root)) {
    const abs = join(root, rel);
    const text = readFileSync(abs, "utf8");
    try {
      pending.push([abs, rel, stampPackageJson(text, version)]);
    } catch (e) {
      throw new Error(`${rel}: ${e.message}`);
    }
  }

  const serverAbs = join(root, "server.json");
  pending.push([serverAbs, "server.json", stampServerJson(readFileSync(serverAbs, "utf8"), version)]);

  const changelogAbs = join(root, "CHANGELOG.md");
  const fragments = readFragments(root);
  pending.push([
    changelogAbs,
    "CHANGELOG.md",
    stampChangelog(foldFragments(readFileSync(changelogAbs, "utf8"), fragments), version),
  ]);

  const changed = [];
  for (const [abs, rel, text] of pending) {
    if (readFileSync(abs, "utf8") !== text) {
      writeFileSync(abs, text);
      changed.push(rel);
    }
  }
  // Only once the CHANGELOG that now carries their text has been written.
  for (const f of fragments) {
    rmSync(join(root, f.rel));
    changed.push(`${f.rel} (folded into CHANGELOG.md)`);
  }
  return changed;
}

/**
 * The read-only mirror of stampTree: is this tree ALREADY at `version`, everywhere, with a
 * release-worthy CHANGELOG section? Returns a list of complaints — empty means yes.
 *
 * It lives here, next to the stamper and sharing its discovery, because the two must agree
 * about what "everywhere" means. A separate verifier with its own package list would be a
 * fifth place to forget a package, and it would be the one place where forgetting is
 * invisible: a verifier that does not know about a package reports success.
 *
 * release.yml asks a version of this question too, after the tag exists. The extra thing
 * asked here is the CHANGELOG, and that is not redundant: release.yml's own CHANGELOG check
 * lives in "Create the GitHub Release", which runs AFTER "Publish packages to npm". Failing
 * it there means nine packages are already on the registry, that version number is burned,
 * and there is no clean re-run. Asked before the tag, it costs nothing.
 */
export function verifyStamp(version, root = ROOT) {
  const problems = [];
  if (!parseVersion(version)) return [`version must be X.Y.Z with no leading "v": got "${version}"`];

  for (const rel of relPathsFor(root)) {
    const v = JSON.parse(readFileSync(join(root, rel), "utf8")).version;
    if (v !== version) problems.push(`${rel} is at ${v}, expected ${version}`);
  }

  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  if (server.version !== version) {
    problems.push(`server.json .version is ${server.version}, expected ${version}`);
  }
  for (const [i, p] of (server.packages ?? []).entries()) {
    if (p.version !== version) {
      problems.push(
        `server.json .packages[${i}] (${p.identifier ?? "?"}) is ${p.version}, expected ${version}`,
      );
    }
  }

  // A fragment still here at tag time was merged after the release was prepared: its change
  // is in the tagged commit, but its note is not in this version's section, so the release
  // would ship it unannounced and announce it later under a version it was not in.
  let leftover = [];
  try {
    leftover = readFragments(root);
  } catch (e) {
    problems.push(e.message);
  }
  for (const f of leftover) {
    problems.push(
      `${f.rel} was not folded into the CHANGELOG — it was merged after the release was ` +
        `prepared; fold it into the ${version} section by hand or prepare the release again`,
    );
  }

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const heading = `## [${version}]`;
  const idx = changelog.indexOf(heading);
  if (idx === -1) {
    problems.push(`CHANGELOG.md has no ${heading} section — the release body would be empty`);
  } else {
    const body = changelog.slice(idx + heading.length).split(/^## \[/m)[0];
    if (body.trim() === "") {
      problems.push(`CHANGELOG.md's ${heading} section is empty — the release body would be empty`);
    }
  }

  return problems;
}

function main(argv) {
  const verify = argv[0] === "--verify";
  const version = (verify ? argv[1] : argv[0])?.replace(/^v/, "");
  if (!version) {
    console.error("usage: node scripts/release-prepare.mjs [--verify] <X.Y.Z>");
    process.exit(2);
  }

  if (verify) {
    const problems = verifyStamp(version);
    for (const p of problems) console.error(`::error::${p}`);
    if (problems.length > 0) {
      console.error(`[release-prepare] tree is NOT ready to tag as v${version}`);
      process.exit(1);
    }
    console.log(`[release-prepare] ✓ tree is stamped to ${version} and has release notes`);
    return;
  }

  const changed = stampTree(version);
  for (const f of changed) console.log(`[release-prepare] stamped ${f}`);
  console.log(`[release-prepare] ${changed.length} file(s) now at ${version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
