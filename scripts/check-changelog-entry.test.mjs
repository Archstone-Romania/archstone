#!/usr/bin/env node
// Tests for check-changelog-entry.mjs, the "every PR carries a CHANGELOG decision" gate in
// ci.yml. Node's built-in runner, like the other repo-root script tests: this tooling lives
// outside the Vitest workspace.
//
//   node --test scripts/check-changelog-entry.test.mjs
//
// Every case builds its own throwaway repository (scripts/test/git-sandbox.mjs), so what is
// under test is the script's reading of a range, never this repository's history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelogEntry, WAIVER } from "./check-changelog-entry.mjs";
import { sandbox } from "./test/git-sandbox.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-changelog-entry.mjs");

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n\n- one\n";

/** A repo with one commit carrying CHANGELOG.md; returns the sandbox and that base SHA. */
function withBase(t) {
  const s = sandbox("changelog-entry-");
  t.after(() => s.cleanup());
  const base = s.commit("chore: initial", { "CHANGELOG.md": CHANGELOG, "src.txt": "a\n" });
  return { s, base };
}

const check = (s, base, extra = {}) => checkChangelogEntry({ cwd: s.dir, base, head: "HEAD", ...extra });

test("passes when the range adds a line to CHANGELOG.md", (t) => {
  const { s, base } = withBase(t);
  s.commit("feat: thing", {
    "CHANGELOG.md": CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- a thing\n"),
    "src.txt": "b\n",
  });
  const r = check(s, base);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /CHANGELOG.md gains 2 line/);
});

test("fails, and says what to do, when nothing touches the CHANGELOG and nothing waives it", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "src.txt": "b\n" });
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.match(r.message, /changelog\.d\/<slug>\.<category>\.md/);
  assert.match(r.message, /Changelog: none — <why a user would not notice>/);
});

test("passes when the range adds a changelog.d/ fragment, without touching CHANGELOG.md", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "changelog.d/thing.fixed.md": "- **A thing.** Fixed.\n", "src.txt": "b\n" });
  const r = check(s, base);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /changelog\.d\/thing\.fixed\.md/);
});

test("editing only changelog.d/README.md is not an entry", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "changelog.d/README.md": "# changelog.d\n\nreworded\n", "src.txt": "b\n" });
  assert.equal(check(s, base).ok, false);
});

test("deleting fragments is not an entry", (t) => {
  const { s } = withBase(t);
  const base = s.commit("fix: earlier", { "changelog.d/earlier.fixed.md": "- earlier\n" });
  s.git("rm", "-q", "changelog.d/earlier.fixed.md");
  s.commit("docs: drop a fragment", { "src.txt": "b\n" });
  assert.equal(check(s, base).ok, false);
});

test("a deletion-only CHANGELOG change is not an entry", (t) => {
  const { s, base } = withBase(t);
  s.commit("docs: trim", { "CHANGELOG.md": CHANGELOG.replace("# Changelog\n\n", "") });
  assert.equal(check(s, base).ok, false);
});

test("a commit trailer waives it, with any of the accepted separators", (t) => {
  for (const sep of ["—", "–", ":", "-", "--"]) {
    const { s, base } = withBase(t);
    s.commit("fix: typo", { "src.txt": "b\n" });
    s.commit(`ci: tweak the runner\n\nChangelog: none ${sep} CI only, nothing ships`);
    const r = check(s, base);
    assert.equal(r.ok, true, `separator ${sep}: ${r.message}`);
    assert.match(r.message, /waived by [0-9a-f]{7}/);
  }
});

test("a bare 'Changelog: none', or one with no real reason, is refused", (t) => {
  for (const line of ["Changelog: none", "Changelog: none —", "Changelog: none — ok", "Changelog: nope — CI only"]) {
    const { s, base } = withBase(t);
    s.commit(`fix: thing\n\n${line}`, { "src.txt": "b\n" });
    assert.equal(check(s, base).ok, false, `should refuse: ${JSON.stringify(line)}`);
  }
});

test("the trailer is matched on its own line, not mid-sentence", () => {
  assert.equal(WAIVER.test("we could add Changelog: none — because reasons"), false);
  assert.equal(WAIVER.test("body\n\nChangelog: none — because reasons\nCo-Authored-By: x"), true);
});

test("a range of only chore(release): commits passes", (t) => {
  const { s, base } = withBase(t);
  s.commit("chore(release): stamp 0.2.0\n\nVersions only.", { "src.txt": "b\n" });
  const r = check(s, base);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /nothing but release commits/);
});

test("chore(release): commits are ignored, not counted as the decision", (t) => {
  const { s, base } = withBase(t);
  s.commit("chore(release): stamp 0.2.0");
  s.commit("fix: thing", { "src.txt": "b\n" });
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.match(r.message, /1 commit\(s\)/);
});

test("the waiver in the PR description counts, including GitHub's CRLF line endings", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "src.txt": "b\n" });
  const r = check(s, base, { prBody: "Fixes the runner.\r\n\r\nChangelog: none — test-only change\r\n" });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /pull request description/);
});

test("a bare waiver in the PR description is refused too", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "src.txt": "b\n" });
  assert.equal(check(s, base, { prBody: "Changelog: none\r\n" }).ok, false);
});

// A pull request's base SHA is main's tip when the event fired. If main edited the CHANGELOG
// after this branch left it, a two-dot diff would read main's edit, reversed, as this branch
// adding a line.
test("CHANGELOG edits made on main after the branch left do not count as this branch's", (t) => {
  const { s } = withBase(t);
  s.git("checkout", "-q", "-b", "topic");
  s.commit("fix: thing", { "src.txt": "b\n" });
  s.git("checkout", "-q", "main");
  const mainTip = s.commit("docs: reword", { "CHANGELOG.md": CHANGELOG.replace("- one", "- uno") });
  const r = checkChangelogEntry({ cwd: s.dir, base: mainTip, head: "topic" });
  assert.equal(r.ok, false, r.message);
});

test("CLI: exit codes 0 / 1 / 2 and PR_BODY from the environment", (t) => {
  const { s, base } = withBase(t);
  s.commit("fix: thing", { "src.txt": "b\n" });
  const run = (args, env = {}) => {
    try {
      execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: s.dir,
        env: { ...process.env, PR_BODY: "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run([base, "HEAD"]), 1);
  assert.equal(run([base, "HEAD"], { PR_BODY: "Changelog: none — docs build only" }), 0);
  assert.equal(run(["no-such-ref", "HEAD"]), 2);
  assert.equal(run([]), 2);
});
