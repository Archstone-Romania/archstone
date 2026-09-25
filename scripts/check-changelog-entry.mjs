// Every pull request carries a CHANGELOG decision: an entry, or a stated reason for none.
//
// CHANGELOG.md is not a side document here. release-prepare.mjs renames its `## [Unreleased]`
// heading to `## [X.Y.Z]` and refuses to run if that section is empty, and release.yml publishes
// the section verbatim as the GitHub Release body. So the release notes are exactly what PRs
// wrote under Unreleased as they landed — and nothing made a PR write anything. An entry that is
// not written when the change lands has to be reconstructed at release time from commit subjects,
// by whoever cuts the release, which is the worst person and the worst moment to do it.
//
// Entries are written as fragments, one file per change under `changelog.d/` (see its README):
// release-prepare.mjs folds them into `## [Unreleased]` before stamping, so PRs stop colliding on
// the same lines of CHANGELOG.md. A hand-written line under Unreleased is still folded in and
// still counts here; it is just the path that conflicts.
//
// This check makes the decision explicit for the range under review, in one of two ways:
//
//   1. the range adds a fragment under changelog.d/ (any file but its README), or adds at least
//      one line to CHANGELOG.md, or
//   2. a commit in the range — or the pull request's description — carries a trailer saying why
//      a user of the published packages would not notice the change:
//
//        Changelog: none — <reason>
//
//      (the separator may be —, –, : or -; a bare "none" with no reason is refused, because the
//      reason is the part a reviewer reads). The PR description counts because contributors
//      working from a fork often edit only that, and because this gate runs on the pull request,
//      which is what branch protection judges — not on the squash commit afterwards.
//
// `chore(release):` commits are not counted. release-prepare.yml's stamp commit is one: it only
// renames a heading and bumps versions, so a range made only of those passes.
//
// Whether the added lines landed UNDER `## [Unreleased]` is deliberately not this script's
// question. check-changelog-history.mjs asks the sharper one — did any released section change —
// and a rebase that reattached an entry under a released heading fails there, with a message
// that says so.
//
// Usage: node scripts/check-changelog-entry.mjs <base> <head>
//   env PR_BODY   the pull request's description, if any, searched for the trailer too
//
// The git calls run in the current working directory's repository, not in this file's: the CLI
// is always started from the repo root in CI, and the tests point checkChangelogEntry() at
// throwaway repositories so they never depend on this repository's own history.

import { execFileSync } from "node:child_process";

const FILE = "CHANGELOG.md";
const FRAGMENT_DIR = "changelog.d";
const RELEASE_COMMIT = /^chore\(release\):/;

/** The waiver. Shared with the tests so they check the same pattern CI does. */
export const WAIVER = /^Changelog:\s*none\s*[—–:-]+\s*\S.{3,}$/im;

function gitIn(cwd) {
  // stderr captured, not inherited: a bad ref is reported by this script in its own words.
  return (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Decide whether `base..head` carries a CHANGELOG decision. Returns `{ ok, message }`; the CLI
 * below only prints it and sets the exit code.
 */
export function checkChangelogEntry({ cwd = process.cwd(), base, head = "HEAD", prBody = "" }) {
  const git = gitIn(cwd);
  const top = git("rev-parse", "--show-toplevel").trim();
  const g = gitIn(top);

  for (const ref of [base, head]) {
    try {
      g("rev-parse", "--verify", `${ref}^{commit}`);
    } catch {
      return { ok: false, code: 2, message: `changelog entry: "${ref}" is not a commit this clone knows.` };
    }
  }

  const commits = g("log", "--format=%H%x00%s%x00%B%x1e", `${base}..${head}`)
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split("\x00");
      return { sha, subject, body };
    })
    .filter((c) => !RELEASE_COMMIT.test(c.subject));

  if (commits.length === 0) {
    return { ok: true, message: "changelog entry: nothing but release commits in range — ok" };
  }

  // Three dots: from the merge base, not from `base` itself. A pull request's base SHA is main's
  // tip when the event fired, and main may have moved past the point this branch left it — a
  // two-dot diff would then count main's own CHANGELOG edits, reversed, as this branch's.
  // Whether a fragment's name is one release-prepare can place is not asked here: that is
  // readFragments()'s job, and release-prepare.test.mjs runs it against the real directory on
  // every PR. This only asks whether the PR wrote one.
  const fragments = g("diff", "--numstat", `${base}...${head}`, "--", FRAGMENT_DIR)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([added, , path]) => Number(added) > 0 && path !== `${FRAGMENT_DIR}/README.md`)
    .map(([, , path]) => path);
  if (fragments.length > 0) {
    return { ok: true, message: `changelog entry: ${fragments.join(", ")} — ok` };
  }

  const numstat = g("diff", "--numstat", `${base}...${head}`, "--", FILE).trim();
  const added = numstat ? Number(numstat.split(/\s+/)[0]) : 0;
  if (added > 0) {
    return { ok: true, message: `changelog entry: ${FILE} gains ${added} line(s) — ok` };
  }

  const waived = commits.find((c) => WAIVER.test(c.body));
  if (waived) {
    return {
      ok: true,
      message: `changelog entry: waived by ${waived.sha.slice(0, 7)} — ${waived.body.match(WAIVER)[0].trim()}`,
    };
  }

  // GitHub stores PR descriptions with CRLF line endings; normalise before matching per line.
  const body = (prBody ?? "").replace(/\r\n?/g, "\n");
  const inBody = body.match(WAIVER);
  if (inBody) {
    return { ok: true, message: `changelog entry: waived by the pull request description — ${inBody[0].trim()}` };
  }

  return {
    ok: false,
    code: 1,
    message:
      `changelog entry: ${commits.length} commit(s) in ${base.slice(0, 7)}..${head.slice(0, 7)} and no changelog decision.\n\n` +
      `Either add a fragment, ${FRAGMENT_DIR}/<slug>.<category>.md, describing what changed for someone\n` +
      `using the published packages (see ${FRAGMENT_DIR}/README.md for the categories and the style), or,\n` +
      "if nothing here is visible to them, add this line to a commit message or to the pull request\n" +
      "description:\n\n" +
      "    Changelog: none — <why a user would not notice>\n\n" +
      'A bare "Changelog: none" is not accepted; the reason is what a reviewer reads. If you edit\n' +
      "only the PR description, re-run this check afterwards — it reads the description when it runs.\n",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) {
    process.stderr.write("usage: node scripts/check-changelog-entry.mjs <base> <head>\n");
    process.exit(2);
  }
  const result = checkChangelogEntry({ base, head, prBody: process.env.PR_BODY ?? "" });
  (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
  process.exit(result.ok ? 0 : result.code);
}
