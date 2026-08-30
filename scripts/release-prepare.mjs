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
//   - It does not write release notes. The `[Unreleased]` section is authored as the work
//     lands; this only renames the heading and opens a fresh empty section above it.
//
// The package set is DISCOVERED (`private: false` under packages/ and providers/), never
// listed here. release-gate.mjs already asserts that discovered set is exactly what
// release.yml stamps and publishes, so discovery is what keeps this script from drifting
// away from the gate that will judge its output. A hardcoded list here would be a fourth
// place to forget a new package.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
  pending.push([
    changelogAbs,
    "CHANGELOG.md",
    stampChangelog(readFileSync(changelogAbs, "utf8"), version),
  ]);

  const changed = [];
  for (const [abs, rel, text] of pending) {
    if (readFileSync(abs, "utf8") !== text) {
      writeFileSync(abs, text);
      changed.push(rel);
    }
  }
  return changed;
}

function main(argv) {
  const version = argv[0];
  if (!version) {
    console.error("usage: node scripts/release-prepare.mjs <X.Y.Z>");
    process.exit(2);
  }
  const changed = stampTree(version.replace(/^v/, ""));
  for (const f of changed) console.log(`[release-prepare] stamped ${f}`);
  console.log(`[release-prepare] ${changed.length} file(s) now at ${version.replace(/^v/, "")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
