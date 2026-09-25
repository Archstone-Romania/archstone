// A released CHANGELOG section is a statement about a version somebody may already be running.
// Once published it does not change.
//
// The failure this exists to catch is silent, not careless. release-prepare.mjs's
// `stampChangelog` renames "## [Unreleased]" IN PLACE to "## [X.Y.Z]" and opens a fresh, empty
// Unreleased above it. A branch that wrote entries under Unreleased before that release, and is
// then rebased onto a main where those neighbouring lines now sit under "## [X.Y.Z]", has its
// hunk anchored by context that moved wholesale into the released section — so git applies it
// there. No conflict, and nothing that looks wrong in the diff, because the entry's text is
// exactly what the author wrote; only its position moved. The result claims a shipped release
// contains work that landed after it, and the next release's notes silently lack it.
// check-changelog-entry.mjs is satisfied either way — lines were added — and release.yml only
// reads the section for the version it is publishing, never the older ones.
//
// So: for every `## [x.y.z]` section that already existed at the merge base, its body must be
// byte-identical (modulo surrounding blank lines) at head. Adding a section is fine — that is
// what a release-prepare PR does. Writing under "## [Unreleased]" is fine. Editing the preamble
// above the first heading is fine.
//
// The legitimate exception — a released section says something wrong, and correcting it is the
// honest thing to do — is declared, in the same shape as the `Changelog: none` waiver. For
// example:
//
//     Changelog-correction: 0.24.0 — named the wrong package as the one carrying this fix
//
// One trailer per section touched, each naming the version and why, in a commit message in the
// range or in the pull request's description. A bare version with no reason is refused: the
// reason is what tells the next reader the edit was meant.
//
// Usage: node scripts/check-changelog-history.mjs <base> <head>
//   env PR_BODY   the pull request's description, if any, searched for the trailer too
//
// Like check-changelog-entry.mjs, git runs in the current working directory's repository, so
// the tests can point checkChangelogHistory() at throwaway repositories.

import { execFileSync } from "node:child_process";

const FILES = ["CHANGELOG.md"];
const RELEASED = /^\d+\.\d+\.\d+$/;

function gitIn(cwd) {
  // stderr is captured rather than inherited: several calls below ask questions whose answer may
  // legitimately be "no such thing" (a file absent at a revision, a ref only one side knows), and
  // git's own complaint about those would otherwise land in the log above this script's.
  return (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `## [x]` headings to the text under them. Everything above the first heading is dropped.
 * Matches only the bracketed part, so a heading that grew a date suffix (`## [1.0.0] - 2027-01-01`)
 * is still found by its version.
 */
export function sections(text) {
  const found = new Map();
  let heading = null;
  let body = [];
  for (const line of text.split("\n")) {
    const match = /^## \[([^\]]+)\]/.exec(line);
    if (match) {
      if (heading !== null) found.set(heading, body.join("\n").trim());
      heading = match[1];
      body = [];
      continue;
    }
    if (heading !== null) body.push(line);
  }
  if (heading !== null) found.set(heading, body.join("\n").trim());
  return found;
}

const CORRECTION = /^Changelog-correction:\s*(\d+\.\d+\.\d+)\s*[—–:-]+\s*\S.{3,}$/gim;

export function checkChangelogHistory({ cwd = process.cwd(), base: baseArg, head = "HEAD", prBody = "" }) {
  const top = gitIn(cwd)("rev-parse", "--show-toplevel").trim();
  const git = gitIn(top);

  for (const ref of [baseArg, head]) {
    try {
      git("rev-parse", "--verify", `${ref}^{commit}`);
    } catch {
      return { ok: false, code: 2, message: `changelog history: "${ref}" is not a commit this clone knows.` };
    }
  }

  // The merge base, not the base ref itself: on a pull request whose branch has not been rebased
  // it is the point the branch left, so releases cut on main since then are not read as sections
  // this branch deleted.
  let base = baseArg;
  try {
    base = git("merge-base", baseArg, head).trim() || baseArg;
  } catch {
    /* unrelated histories: fall back to the ref as given */
  }

  const at = (rev, file) => {
    try {
      return git("show", `${rev}:${file}`);
    } catch {
      return null;
    }
  };

  const declared = new Map();
  for (const record of git("log", "--format=%H%x00%B%x1e", `${base}..${head}`).split("\x1e")) {
    const [sha, body = ""] = record.trim().split("\x00");
    if (!sha) continue;
    for (const match of body.matchAll(CORRECTION)) {
      if (!declared.has(match[1])) declared.set(match[1], { by: sha.slice(0, 7), line: match[0].trim() });
    }
  }
  for (const match of (prBody ?? "").replace(/\r\n?/g, "\n").matchAll(CORRECTION)) {
    if (!declared.has(match[1])) declared.set(match[1], { by: "the pull request description", line: match[0].trim() });
  }

  const violations = [];
  for (const file of FILES) {
    const before = at(base, file);
    const after = at(head, file);
    if (before === null) continue; // new in this range — nothing of it is published yet
    if (after === null) {
      violations.push({ file, version: null, what: "the whole file was deleted" });
      continue;
    }
    const wasThere = sections(before);
    const isThere = sections(after);
    for (const [version, body] of wasThere) {
      if (!RELEASED.test(version)) continue;
      if (!isThere.has(version)) {
        violations.push({ file, version, what: `the "## [${version}]" section is gone` });
        continue;
      }
      if (isThere.get(version) === body) continue;
      const beforeLines = new Set(body.split("\n"));
      const gained = isThere
        .get(version)
        .split("\n")
        .filter((line) => line.trim() !== "" && !beforeLines.has(line));
      violations.push({
        file,
        version,
        what: gained.length > 0 ? `${gained.length} line(s) appeared under "## [${version}]"` : `"## [${version}]" was edited`,
        sample: gained.slice(0, 3),
      });
    }
  }

  const undeclared = violations.filter((v) => v.version === null || !declared.has(v.version));

  const notes = [];
  for (const [version, { by, line }] of declared) {
    notes.push(
      violations.some((v) => v.version === version)
        ? `changelog history: ${version} corrected on purpose by ${by} — ${line}`
        : `changelog history: note — ${by} declares a correction to ${version}, which nothing in this range changed`,
    );
  }

  if (undeclared.length === 0) {
    notes.push(`changelog history: released sections unchanged since ${base.slice(0, 7)} — ok`);
    return { ok: true, message: notes.join("\n") };
  }

  let message = notes.length > 0 ? `${notes.join("\n")}\n` : "";
  message += `changelog history: ${undeclared.length} released section(s) changed in ${base.slice(0, 7)}..${head.slice(0, 7)}.\n\n`;
  for (const v of undeclared) {
    message += `  ${v.file}: ${v.what}\n`;
    for (const line of v.sample ?? []) message += `      ${line.length > 96 ? `${line.slice(0, 96)}…` : line}\n`;
  }
  message +=
    "\nA released section describes a version somebody may already be running, so it does not gain\n" +
    "entries after the fact. The usual cause is a rebase: entries written under \"## [Unreleased]\"\n" +
    "before a release landed reattach under the heading that content was renamed to — silently,\n" +
    "with no conflict and nothing visibly wrong in the diff. Open CHANGELOG.md and look at where\n" +
    "your entries actually are now.\n\n" +
    "Move them back under \"## [Unreleased]\" — or, if the edit is a deliberate correction to what\n" +
    "that release said, declare it in a commit message or the pull request description:\n\n" +
    "    Changelog-correction: <x.y.z> — <what was wrong>\n";
  return { ok: false, code: 1, message };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    process.stderr.write("usage: node scripts/check-changelog-history.mjs <base> <head>\n");
    process.exit(2);
  }
  const result = checkChangelogHistory({ base, head, prBody: process.env.PR_BODY ?? "" });
  (result.ok ? process.stdout : process.stderr).write(`${result.message.replace(/\n$/, "")}\n`);
  process.exit(result.ok ? 0 : result.code);
}
