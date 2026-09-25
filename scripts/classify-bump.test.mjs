#!/usr/bin/env node
// Tests for classify-bump.mjs, which computes release-prepare.yml's default (`bump: auto`)
// version. Node's built-in runner, like the other repo-root script tests.
//
//   node --test scripts/classify-bump.test.mjs
//
// The cases are the ways a Conventional Commits reader goes wrong on THIS repository's history:
// squash-merged PRs whose deciding commit is buried in the body, merge commits, subjects with no
// prefix at all, and the pre-1.0 rule that keeps a computed default from ever producing 1.0.0.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBump, classifyCommit, describe } from "./classify-bump.mjs";
import { sandbox } from "./test/git-sandbox.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "classify-bump.mjs");

const c = (subject, body = "", sha) => ({ subject, body, ...(sha ? { sha } : {}) });

test("classifyCommit: the three kinds from a subject", () => {
  assert.equal(classifyCommit(c("fix(cli): x")).kind, "patch");
  assert.equal(classifyCommit(c("docs: x")).kind, "patch");
  assert.equal(classifyCommit(c("feat: x")).kind, "feature");
  assert.equal(classifyCommit(c("feat(agent): x")).kind, "feature");
  assert.equal(classifyCommit(c("feat!: x")).kind, "breaking");
  assert.equal(classifyCommit(c("fix(runtime)!: x")).kind, "breaking");
  assert.equal(classifyCommit(c("refactor!: x")).kind, "breaking");
});

test("classifyCommit: unprefixed and not-quite-conventional subjects are patches", () => {
  for (const subject of ["Update README.md", "featuring: x", "Feat: x", 'Revert "feat: x"', "feat x"]) {
    assert.equal(classifyCommit(c(subject)).kind, "patch", subject);
  }
});

test("classifyCommit: a BREAKING CHANGE / BREAKING-CHANGE footer anywhere in the body", () => {
  assert.equal(classifyCommit(c("fix: x", "Some text.\n\nBREAKING CHANGE: the flag is gone")).kind, "breaking");
  assert.equal(classifyCommit(c("fix: x", "BREAKING-CHANGE: the flag is gone")).kind, "breaking");
  assert.equal(classifyCommit(c("fix: x", "This is breaking change: not a footer")).kind, "patch");
});

// GitHub's squash body: every PR commit as `* subject`, then its body. The PR title is the
// subject, and it can understate what the PR contains.
test("classifyCommit: a squash body's inner commits count — feat!: and a footer in commit three", () => {
  const squashFeatBang = [
    "* fix(agent): split the openai format (#89)",
    "",
    "Body of the first commit.",
    "",
    "* feat(agent)!: drop the openai alias",
    "",
    "Co-authored-by: Someone <s@example.invalid>",
  ].join("\n");
  const r1 = classifyCommit(c("fix(agent): split openai format (#90)", squashFeatBang));
  assert.equal(r1.kind, "breaking");
  assert.match(r1.why, /inside the body/);

  const squashFooter = [
    "* fix: one",
    "",
    "* docs: two",
    "",
    "* refactor: three",
    "",
    "The loader now rejects v1 manifests.",
    "",
    "BREAKING CHANGE: v1 manifests are no longer accepted",
  ].join("\n");
  assert.equal(classifyCommit(c("fix: tidy the loader (#12)", squashFooter)).kind, "breaking");

  assert.equal(classifyCommit(c("fix: x (#3)", "* fix: a\n\n* feat(cli): b\n")).kind, "feature");
});

test("classifyCommit: prose in a body is not read as a header", () => {
  const body = "Note: this touches the loader.\nWarning!: not a type.\nfeature: also not one\n";
  assert.equal(classifyCommit(c("fix: x", body)).kind, "patch");
});

test("classifyCommit: a merge commit is classified by the PR title in its body", () => {
  assert.equal(classifyCommit(c("Merge pull request #7 from a/b", "feat(sql): add the sql provider")).kind, "feature");
  assert.equal(classifyCommit(c("Merge branch 'main' into topic", "")).kind, "patch");
});

test("classifyBump pre-1.0: feat -> minor, fix -> patch, breaking -> MINOR (never 1.0.0)", () => {
  assert.equal(classifyBump("0.24.0", [c("fix: a"), c("docs: b")]).nextVersion, "0.24.1");
  assert.equal(classifyBump("0.24.3", [c("fix: a"), c("feat: b")]).nextVersion, "0.25.0");
  const breaking = classifyBump("0.24.3", [c("fix: a"), c("feat!: b")]);
  assert.equal(breaking.bump, "minor");
  assert.equal(breaking.kind, "breaking");
  assert.equal(breaking.nextVersion, "0.25.0");
  assert.match(describe(breaking, "v0.24.3"), /held at a minor bump/);
  assert.equal(classifyBump("0.9.0", [c("fix: a", "BREAKING CHANGE: gone")]).nextVersion, "0.10.0");
});

test("classifyBump post-1.0: breaking -> major, feat -> minor, fix -> patch", () => {
  assert.equal(classifyBump("1.2.3", [c("fix: a")]).nextVersion, "1.2.4");
  assert.equal(classifyBump("1.2.3", [c("fix: a"), c("feat: b")]).nextVersion, "1.3.0");
  assert.equal(classifyBump("1.2.3", [c("feat: b"), c("fix!: a")]).nextVersion, "2.0.0");
  assert.doesNotMatch(describe(classifyBump("1.2.3", [c("fix!: a")]), "v1.2.3"), /held at/);
});

test("classifyBump: the highest wins, and decidedBy names the commits that decided it", () => {
  const r = classifyBump("0.24.0", [c("fix: a", "", "a".repeat(40)), c("feat: b", "", "b".repeat(40)), c("feat(x): c", "", "c".repeat(40))]);
  assert.equal(r.bump, "minor");
  assert.deepEqual(r.decidedBy.map((d) => d.subject), ["feat: b", "feat(x): c"]);
  const text = describe(r, "v0.24.0");
  assert.match(text, /bump: minor — 0\.24\.0 -> 0\.25\.0/);
  assert.match(text, /decided by \(feature\):\n {2}bbbbbbb {2}feat: b/);
});

test("classifyBump: chore(release): commits are skipped, and alone they are nothing to release", () => {
  const r = classifyBump("0.24.0", [c("chore(release): stamp 0.24.0 (#77)"), c("fix: a")]);
  assert.equal(r.commits.length, 1);
  assert.equal(r.skipped.length, 1);
  // A stamp commit whose body lists a feat (a squash of the prepare PR, say) still does not count.
  assert.equal(classifyBump("0.24.0", [c("chore(release): stamp 0.25.0", "* feat: x"), c("fix: a")]).bump, "patch");
  assert.throws(() => classifyBump("0.24.0", [c("chore(release): stamp 0.24.0")]), /only release commits/);
  assert.throws(() => classifyBump("0.24.0", []), /no commits since 0\.24\.0/);
  assert.throws(() => classifyBump("v0.24.0", [c("fix: a")]), /not X\.Y\.Z/);
});

test("CLI: counts from the last v* tag reachable from HEAD and prints GITHUB_OUTPUT lines", (t) => {
  const s = sandbox("classify-bump-");
  t.after(() => s.cleanup());
  s.commit("chore: initial", { "package.json": '{ "version": "0.3.0" }\n' });
  s.git("tag", "v0.3.0");
  s.commit("fix: one");
  s.git("tag", "not-a-release");
  s.commit("feat(cli): two");
  s.commit("chore(release): stamp 0.4.0", { "package.json": '{ "version": "0.4.0" }\n' });

  const run = (args = []) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: s.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const out = run();
  assert.match(out, /^bump=minor$/m);
  assert.match(out, /^next_version=0\.4\.0$/m);
  assert.match(out, /^commit_count=2$/m);
  assert.match(out, /^last_tag=v0\.3\.0$/m);
  assert.match(out, /^decided_by=[0-9a-f]{7}$/m);

  // --since a plain commit reads the version from package.json there.
  const second = s.git("rev-list", "--max-count=1", "--skip=2", "HEAD");
  const since = run(["--since", second]);
  assert.match(since, /^current_version=0\.3\.0$/m);
  assert.match(since, /^commit_count=1$/m);
});

test("CLI: exits non-zero, with a reason, when there is nothing to release or no tag", (t) => {
  const s = sandbox("classify-bump-");
  t.after(() => s.cleanup());
  s.commit("chore: initial", { "package.json": '{ "version": "0.3.0" }\n' });

  const run = () => {
    try {
      execFileSync(process.execPath, [SCRIPT], { cwd: s.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stderr: "" };
    } catch (e) {
      return { status: e.status, stderr: e.stderr };
    }
  };

  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no v\* tag is reachable/);

  s.git("tag", "v0.3.0");
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no commits since 0\.3\.0/);
});
