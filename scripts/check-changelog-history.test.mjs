#!/usr/bin/env node
// Tests for check-changelog-history.mjs, the "released CHANGELOG sections are unchanged" gate
// in ci.yml. Node's built-in runner, like the other repo-root script tests.
//
//   node --test scripts/check-changelog-history.test.mjs
//
// The case that matters most is the last-but-one: a real `git rebase` across a real
// `stampChangelog` (imported from release-prepare.mjs, not paraphrased), which is the silent
// failure this gate exists for. It is reproduced rather than simulated so that if git's
// behaviour or the stamper's output ever changes shape, this test notices first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkChangelogHistory, sections } from "./check-changelog-history.mjs";
import { checkChangelogEntry } from "./check-changelog-entry.mjs";
import { stampChangelog } from "./release-prepare.mjs";
import { sandbox } from "./test/git-sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-changelog-history.mjs");

const CHANGELOG = [
  "# Changelog",
  "",
  "Preamble.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- alpha",
  "",
  "## [0.1.0]",
  "",
  "### Added",
  "",
  "- one",
  "",
].join("\n");

function withBase(t, text = CHANGELOG) {
  const s = sandbox("changelog-history-");
  t.after(() => s.cleanup());
  const base = s.commit("chore: initial", { "CHANGELOG.md": text });
  return { s, base };
}

const check = (s, base, head = "HEAD", prBody = "") => checkChangelogHistory({ cwd: s.dir, base, head, prBody });

test("sections: parses this repository's real CHANGELOG headings", () => {
  const real = readFileSync(resolve(HERE, "..", "CHANGELOG.md"), "utf8");
  const found = sections(real);
  assert.ok(found.has("Unreleased"));
  const released = [...found.keys()].filter((k) => /^\d+\.\d+\.\d+$/.test(k));
  const headings = real.split("\n").filter((l) => /^## \[/.test(l));
  // Every heading is a plain `## [x]` — no dates, no suffixes — and every one was recognised.
  assert.equal(found.size, headings.length);
  assert.ok(released.length > 10, `expected many released sections, got ${released.length}`);
  for (const [, body] of found) assert.doesNotMatch(body, /^## \[/m);
});

test("sections: a heading with a date suffix is still keyed by its version", () => {
  const found = sections("## [1.0.0] - 2027-01-01\n\n- x\n\n## [0.9.0]\n- y\n");
  assert.deepEqual([...found.keys()], ["1.0.0", "0.9.0"]);
  assert.equal(found.get("1.0.0"), "- x");
});

test("passes when only Unreleased and the preamble change", (t) => {
  const { s, base } = withBase(t);
  s.commit("feat: beta", {
    "CHANGELOG.md": CHANGELOG.replace("Preamble.", "A new preamble.").replace("- alpha\n", "- alpha\n- beta\n"),
  });
  const r = check(s, base);
  assert.equal(r.ok, true, r.message);
});

test("passes when a release adds a section (what a release-prepare PR does)", (t) => {
  const { s, base } = withBase(t);
  s.commit("chore(release): stamp 0.2.0", { "CHANGELOG.md": stampChangelog(CHANGELOG, "0.2.0") });
  assert.equal(check(s, base).ok, true);
});

test("fails when a released section is deleted", (t) => {
  const { s, base } = withBase(t);
  s.commit("docs: tidy", { "CHANGELOG.md": CHANGELOG.slice(0, CHANGELOG.indexOf("## [0.1.0]")) });
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.match(r.message, /"## \[0\.1\.0\]" section is gone/);
});

test("fails when the whole file is deleted", (t) => {
  const { s, base } = withBase(t);
  s.git("rm", "-q", "CHANGELOG.md");
  s.commit("chore: remove changelog");
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.match(r.message, /whole file was deleted/);
});

test("fails when a released section is edited, and shows the new line", (t) => {
  const { s, base } = withBase(t);
  s.commit("docs: reword", { "CHANGELOG.md": CHANGELOG.replace("- one", "- one, reworded") });
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.match(r.message, /1 line\(s\) appeared under "## \[0\.1\.0\]"/);
  assert.match(r.message, /- one, reworded/);
  assert.match(r.message, /look at where\s+your entries actually are/);
});

test("fails when a line is only removed from a released section", (t) => {
  const { s, base } = withBase(t);
  s.commit("docs: trim", { "CHANGELOG.md": CHANGELOG.replace("### Added\n\n- one", "- one") });
  const r = check(s, base);
  assert.equal(r.ok, false);
  assert.match(r.message, /"## \[0\.1\.0\]" was edited/);
});

test("a declared correction passes — in a commit or in the PR description", (t) => {
  {
    const { s, base } = withBase(t);
    s.commit("docs: fix 0.1.0 entry\n\nChangelog-correction: 0.1.0 — the entry named the wrong package", {
      "CHANGELOG.md": CHANGELOG.replace("- one", "- uno"),
    });
    const r = check(s, base);
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /0\.1\.0 corrected on purpose/);
  }
  {
    const { s, base } = withBase(t);
    s.commit("docs: fix 0.1.0 entry", { "CHANGELOG.md": CHANGELOG.replace("- one", "- uno") });
    const r = check(s, base, "HEAD", "Fixes a typo.\r\n\r\nChangelog-correction: 0.1.0 – the entry named the wrong package\r\n");
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /pull request description/);
  }
});

test("a correction with no reason, or for a different version, does not excuse the edit", (t) => {
  for (const trailer of ["Changelog-correction: 0.1.0", "Changelog-correction: 0.1.0 —", "Changelog-correction: 0.9.9 — wrong one"]) {
    const { s, base } = withBase(t);
    s.commit(`docs: fix\n\n${trailer}`, { "CHANGELOG.md": CHANGELOG.replace("- one", "- uno") });
    assert.equal(check(s, base).ok, false, `should refuse with ${JSON.stringify(trailer)}`);
  }
});

test("a release cut on main after the branch left is not read as this branch deleting it", (t) => {
  const { s } = withBase(t);
  s.git("checkout", "-q", "-b", "topic");
  s.commit("feat: beta", { "CHANGELOG.md": CHANGELOG.replace("- alpha\n", "- alpha\n- beta\n") });
  s.git("checkout", "-q", "main");
  const mainTip = s.commit("chore(release): stamp 0.2.0", { "CHANGELOG.md": stampChangelog(CHANGELOG, "0.2.0") });
  const r = check(s, mainTip, "topic");
  assert.equal(r.ok, true, r.message);
});

// The failure this gate exists for, reproduced end to end: the branch writes under Unreleased,
// main is stamped, the branch is rebased — cleanly — and its entry now sits under the release.
test("catches a rebase that silently reattached an entry under a released heading", (t) => {
  const { s } = withBase(t);
  s.git("checkout", "-q", "-b", "topic");
  s.commit("feat: beta", { "CHANGELOG.md": CHANGELOG.replace("- alpha\n", "- alpha\n- beta\n") });
  s.git("checkout", "-q", "main");
  const mainTip = s.commit("chore(release): stamp 0.2.0", { "CHANGELOG.md": stampChangelog(CHANGELOG, "0.2.0") });
  s.git("checkout", "-q", "topic");
  s.git("rebase", "-q", "main"); // no conflict: that is the point

  const after = readFileSync(join(s.dir, "CHANGELOG.md"), "utf8");
  assert.match(
    sections(after).get("0.2.0"),
    /- beta/,
    "precondition: git reattached the entry under the released heading",
  );
  assert.equal(sections(after).get("Unreleased"), "", "precondition: and Unreleased is empty");

  // The entry gate is satisfied — a line was added — which is why this second gate exists.
  assert.equal(checkChangelogEntry({ cwd: s.dir, base: mainTip, head: "topic" }).ok, true);

  const r = check(s, mainTip, "topic");
  assert.equal(r.ok, false);
  assert.match(r.message, /1 line\(s\) appeared under "## \[0\.2\.0\]"/);
  assert.match(r.message, /- beta/);
});

test("CLI: exit codes 0 / 1 / 2 and PR_BODY from the environment", (t) => {
  const { s, base } = withBase(t);
  s.commit("docs: reword", { "CHANGELOG.md": CHANGELOG.replace("- one", "- uno") });
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
  assert.equal(run([base, "HEAD"], { PR_BODY: "Changelog-correction: 0.1.0 — typo in the entry" }), 0);
  assert.equal(run(["no-such-ref", "HEAD"]), 2);
  assert.equal(run([]), 2);
});
