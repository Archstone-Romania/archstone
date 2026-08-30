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
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVersion,
  nextVersion,
  discoverPublishablePackages,
  stampPackageJson,
  stampServerJson,
  stampChangelog,
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
