#!/usr/bin/env node
// Regression tests for the pure helpers exported by release-prepare.mjs. Same reasoning as
// release-gate.test.mjs: repo-root CI tooling lives outside the Vitest workspace, so this
// uses Node's built-in runner rather than adding a dependency for one script.
//
//   node --test scripts/release-prepare.test.mjs
//
// The stakes here are the reason the tests are this specific. This script's output is judged
// by release.yml's stamp assertion and by release-gate.mjs, both of which run AFTER a tag
// exists — so every defect it can have costs a deleted tag and a re-tag. The cases below are
// the ways a naive text substitution goes wrong on this repo's actual files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseVersion,
  nextVersion,
  discoverPublishablePackages,
  stampPackageJson,
  stampServerJson,
  stampChangelog,
  stampTree,
  verifyStamp,
} from "./release-prepare.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("parseVersion: accepts X.Y.Z, rejects everything else", () => {
  assert.deepEqual(parseVersion("0.19.0"), { major: 0, minor: 19, patch: 0 });
  for (const bad of ["v0.19.0", "0.19", "0.19.0-rc.1", "1.2.3.4", "", null, undefined]) {
    assert.equal(parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("nextVersion: bumps each level and zeroes the ones below", () => {
  assert.equal(nextVersion("0.18.0", "minor"), "0.19.0");
  assert.equal(nextVersion("0.18.3", "minor"), "0.19.0");
  assert.equal(nextVersion("0.18.3", "patch"), "0.18.4");
  assert.equal(nextVersion("0.18.3", "major"), "1.0.0");
  assert.throws(() => nextVersion("0.18.0", "sideways"), /unknown bump/);
  assert.throws(() => nextVersion("nope", "minor"), /not semver/);
});

test("stampPackageJson: rewrites the version and changes nothing else", () => {
  const before = '{\n  "name": "@archstone/cli",\n  "version": "0.18.0",\n  "type": "module"\n}\n';
  const after = stampPackageJson(before, "0.19.0");
  assert.equal(after, '{\n  "name": "@archstone/cli",\n  "version": "0.19.0",\n  "type": "module"\n}\n');
});

// The failure that motivates rewriting text instead of JSON.stringify: a reviewer has to be
// able to see that a release PR touches one line per file and nothing else.
test("stampPackageJson: preserves formatting, key order and the trailing newline", () => {
  const before = '{\n\t"name": "x",\n\n\t"version": "0.18.0",\n\t"z": 1,\n\t"a": 2\n}\n';
  const after = stampPackageJson(before, "0.19.0");
  assert.equal(after, before.replace("0.18.0", "0.19.0"));
});

// A nested version — dependency ranges, devEngines.packageManager.version — is at a deeper
// indent and must survive untouched. Only the top-level field is the package's own version.
test("stampPackageJson: leaves nested version fields alone", () => {
  const before = [
    "{",
    '  "name": "@archstone/cli",',
    '  "version": "0.18.0",',
    '  "devEngines": {',
    '    "packageManager": {',
    '      "name": "pnpm",',
    '      "version": "11.13.1"',
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  const after = stampPackageJson(before, "0.19.0");
  assert.match(after, /"version": "0\.19\.0",/);
  assert.match(after, /"version": "11\.13\.1"/, "pnpm pin must survive");
  assert.equal(after.match(/0\.19\.0/g).length, 1);
});

test("stampPackageJson: throws when there is no version field to stamp", () => {
  assert.throws(() => stampPackageJson('{\n  "name": "x"\n}\n', "0.19.0"), /no top-level "version"/);
});

// #101 — server.json carries the version once at the root and once per packages[] entry.
// Stamping only the root is the silent half-failure this guards.
test("stampServerJson: rewrites the root version and every packages[] entry", () => {
  const before = JSON.stringify(
    {
      name: "io.github.archstone/archstone",
      version: "0.18.0",
      packages: [
        { identifier: "@archstone/cli", version: "0.18.0" },
        { identifier: "@archstone/runtime", version: "0.18.0" },
      ],
    },
    null,
    2,
  );
  const parsed = JSON.parse(stampServerJson(before, "0.19.0"));
  assert.equal(parsed.version, "0.19.0");
  assert.deepEqual(parsed.packages.map((p) => p.version), ["0.19.0", "0.19.0"]);
});

test("stampServerJson: throws when the manifest shape no longer matches the count", () => {
  // A version field nested somewhere the count does not predict: better to stop than to
  // stamp an unknown shape and let the release gate find it after the tag exists.
  const odd = JSON.stringify(
    { version: "0.18.0", packages: [{ version: "0.18.0" }], extra: { version: "0.18.0" } },
    null,
    2,
  );
  assert.throws(() => stampServerJson(odd, "0.19.0"), /expected 2 version fields/);
});

test("stampChangelog: renames Unreleased and opens a fresh empty one above it", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a thing\n\n## [0.18.0]\n\n- older\n";
  const after = stampChangelog(before, "0.19.0");
  assert.equal(
    after,
    "# Changelog\n\n## [Unreleased]\n\n## [0.19.0]\n\n### Added\n\n- a thing\n\n## [0.18.0]\n\n- older\n",
  );
});

// release.yml awk-extracts `## [X.Y.Z]` as the GitHub Release body and fails on an empty
// one. Catching it here costs a re-run; catching it there costs a deleted tag.
test("stampChangelog: refuses an empty Unreleased section", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n## [0.18.0]\n\n- older\n";
  assert.throws(() => stampChangelog(before, "0.19.0"), /nothing to release/);
});

test("stampChangelog: refuses to stamp a version that already has a section", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n- a thing\n\n## [0.19.0]\n\n- already\n";
  assert.throws(() => stampChangelog(before, "0.19.0"), /already has a section/);
});

test("stampChangelog: throws when there is no Unreleased section at all", () => {
  assert.throws(() => stampChangelog("# Changelog\n\n## [0.18.0]\n", "0.19.0"), /no ## \[Unreleased\]/);
});

// ---------------------------------------------------------------------------------------
// Against the real tree. These are the tripwires: they fail when a package is added,
// renamed or flipped to private:false without this script learning about it.
// ---------------------------------------------------------------------------------------

test("discoverPublishablePackages: matches the real workspace, and every file is stampable", () => {
  const found = discoverPublishablePackages(ROOT);
  assert.ok(found.length >= 8, `expected at least 8 publishable packages, found ${found.length}`);
  for (const rel of found) {
    assert.match(rel, /^(packages|providers)\/[^/]+\/package\.json$/);
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotThrow(() => stampPackageJson(text, "9.9.9"), `${rel} has no stampable version`);
  }
});

// The set this script stamps must be the set release.yml asserts. release-gate.mjs already
// polices release.yml against the workspace; this closes the triangle from the other side,
// so a package can never be publishable, asserted at release time, and missed here.
test("the real tree is in lockstep: root, every package and server.json agree", () => {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  for (const rel of discoverPublishablePackages(ROOT)) {
    const v = JSON.parse(readFileSync(join(ROOT, rel), "utf8")).version;
    assert.equal(v, root, `${rel} is at ${v} but the root is at ${root}`);
  }
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
  assert.equal(server.version, root, "server.json root version drifted");
  for (const p of server.packages ?? []) {
    assert.equal(p.version, root, `server.json packages[${p.identifier}] drifted`);
  }
});

// ---------------------------------------------------------------------------------------
// verifyStamp — the pre-tag gate. Each case below is a way to reach a tag that publishes
// eight packages and then fails, or publishes them under an empty release.
// ---------------------------------------------------------------------------------------

/** A minimal but structurally real tree: root, two publishable packages, one private one,
 *  server.json with two entries, and a CHANGELOG. */
function fixtureTree(version, { changelogBody = "\n\n### Fixed\n\n- a thing\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-prepare-"));
  const pkg = (name, extra = {}) =>
    JSON.stringify({ name, version, private: false, ...extra }, null, 2) + "\n";

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", version }, null, 2) + "\n");
  for (const [group, name] of [
    ["packages", "schema"],
    ["packages", "cli"],
    ["providers", "rest"],
  ]) {
    mkdirSync(join(dir, group, name), { recursive: true });
    writeFileSync(join(dir, group, name, "package.json"), pkg(`@archstone/${name}`));
  }
  // A private package must be ignored by both stamping and verification.
  mkdirSync(join(dir, "packages", "internal"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "internal", "package.json"),
    JSON.stringify({ name: "internal", version: "0.0.0", private: true }, null, 2) + "\n",
  );

  writeFileSync(
    join(dir, "server.json"),
    JSON.stringify(
      { name: "io.github.archstone/archstone", version, packages: [{ identifier: "@archstone/cli", version }] },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${version}]${changelogBody}\n## [0.0.1]\n\n- old\n`);
  return dir;
}

test("verifyStamp: a fully stamped tree with notes has no complaints", () => {
  const dir = fixtureTree("0.19.1");
  try {
    assert.deepEqual(verifyStamp("0.19.1", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyStamp: names every package left behind, not just the first", () => {
  const dir = fixtureTree("0.19.1");
  try {
    writeFileSync(
      join(dir, "packages", "cli", "package.json"),
      JSON.stringify({ name: "@archstone/cli", version: "0.19.0", private: false }, null, 2) + "\n",
    );
    writeFileSync(
      join(dir, "providers", "rest", "package.json"),
      JSON.stringify({ name: "@archstone/rest", version: "0.18.0", private: false }, null, 2) + "\n",
    );
    const problems = verifyStamp("0.19.1", dir);
    assert.equal(problems.length, 2, problems.join("; "));
    assert.ok(problems.some((p) => p.includes("packages/cli/package.json") && p.includes("0.19.0")));
    assert.ok(problems.some((p) => p.includes("providers/rest/package.json") && p.includes("0.18.0")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyStamp: catches server.json drift in the root and in packages[]", () => {
  const dir = fixtureTree("0.19.1");
  try {
    writeFileSync(
      join(dir, "server.json"),
      JSON.stringify(
        { version: "0.19.0", packages: [{ identifier: "@archstone/cli", version: "0.18.0" }] },
        null,
        2,
      ) + "\n",
    );
    const problems = verifyStamp("0.19.1", dir);
    assert.equal(problems.length, 2, problems.join("; "));
    assert.ok(problems.some((p) => p.includes(".version")));
    assert.ok(problems.some((p) => p.includes("packages[0]")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The case that costs the most to discover late: release.yml's own CHANGELOG check runs in
// "Create the GitHub Release", AFTER "Publish packages to npm".
test("verifyStamp: refuses a version with no CHANGELOG section", () => {
  const dir = fixtureTree("0.19.1");
  try {
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.19.0]\n\n- older\n");
    const problems = verifyStamp("0.19.1", dir);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], /no ## \[0\.19\.1\] section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyStamp: refuses a CHANGELOG section that exists but is empty", () => {
  const dir = fixtureTree("0.19.1", { changelogBody: "\n\n" });
  try {
    const problems = verifyStamp("0.19.1", dir);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], /section is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyStamp: rejects a malformed version before reading anything", () => {
  assert.deepEqual(verifyStamp("v0.19.1", "/nonexistent"), [
    'version must be X.Y.Z with no leading "v": got "v0.19.1"',
  ]);
});

// stampTree and verifyStamp must agree about what "everywhere" means — that is the whole
// reason they share discoverPublishablePackages rather than each carrying a list.
test("stampTree then verifyStamp: the stamper's output satisfies the verifier", () => {
  const dir = fixtureTree("0.19.0");
  try {
    // Put the notes under [Unreleased] so stampTree has something to promote.
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a thing\n\n## [0.19.0]\n\n- older\n",
    );
    const changed = stampTree("0.19.1", dir);
    assert.equal(changed.length, 6, `expected root + 3 packages + server.json + CHANGELOG, got ${changed}`);
    assert.deepEqual(verifyStamp("0.19.1", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
