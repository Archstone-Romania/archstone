// Compute the next release version from the commits since the last one — the default for
// release-prepare.yml's `bump` input (`auto`).
//
// A person still decides WHEN to release: dispatching Release prepare, and merging the PR it
// stamps, are both human acts, and nothing here runs on its own. What this takes off that person
// is the arithmetic of WHICH number — reading every commit since the last tag and remembering
// that one `feat:` among thirty `fix:`es makes it a minor. The number it picks is printed into
// the run summary with the commits that decided it, and it is then read again by whoever
// reviews the prepare PR, so a surprising answer has two chances to be noticed before a tag.
//
// It writes nothing. It reads git history and prints `key=value` lines on stdout, suitable for
// appending straight to $GITHUB_OUTPUT, and a human-readable per-commit breakdown on stderr.
//
// Usage:
//   node scripts/classify-bump.mjs              classify HEAD against the last v* tag reachable
//                                               from it
//   node scripts/classify-bump.mjs --since REF  classify HEAD against REF instead (a tag, or any
//                                               commit, in which case the current version is
//                                               read from package.json at REF) — for trying it
//                                               against a scratch clone; the workflow never
//                                               passes this
//
// THE RULE (Conventional Commits -> semver), taking the highest bump across every commit:
//
//   breaking — `type!:` / `type(scope)!:` in a header, or a `BREAKING CHANGE:` /
//              `BREAKING-CHANGE:` footer anywhere in the body
//   feature  — `feat:` / `feat(scope):`
//   anything else — `fix:`, `docs:`, `chore:`, unprefixed subjects, merge commits — patch
//
//   while the current major is 0:   breaking -> MINOR   feature -> MINOR   else -> PATCH
//   from 1.0.0 on:                  breaking -> MAJOR   feature -> MINOR   else -> PATCH
//
// The pre-1.0 row is the one the semver spec leaves open and this project closes: 0.x is where
// breaking changes are expected, and a computed default must never produce 1.0.0 by accident.
// 1.0.0 is a statement, so it only happens through an explicit `major` or `version` input.
//
// "Header" includes the ones INSIDE a body. archstone lands PRs as squash merges, and GitHub
// writes every commit of the PR into the squash body as `* type(scope): subject` lines, followed
// by their bodies; a merge commit's body is the PR title. So a PR titled `fix: …` that contains
// a `feat!:` commit, or a `BREAKING CHANGE:` footer in its third commit, is classified by that
// commit. Inside a body only the standard Conventional Commits types count, so a prose line such
// as `Note: …` is never read as a header.
//
// `chore(release):` commits are skipped: they are release-prepare's own stamp commits, and
// counting them would make every release after the first at least a patch by itself.

import { execFileSync } from "node:child_process";
import { nextVersion, parseVersion } from "./release-prepare.mjs";

const RELEASE_COMMIT = /^chore\(release\):/;
const SUBJECT_HEADER = /^([a-zA-Z]+)(?:\([^)]*\))?(!)?:/;
const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
const BODY_HEADER = new RegExp(`^[ \\t]*(?:[*-][ \\t]+)?(${TYPES})(?:\\([^)]*\\))?(!)?:[ \\t]`, "gm");
const BREAKING_FOOTER = /^[ \t]*BREAKING[ -]CHANGE:/m;

const RANK = { patch: 0, feature: 1, breaking: 2 };

/** One commit's kind — breaking / feature / patch — and the text that made it so. */
export function classifyCommit({ subject = "", body = "" }) {
  const found = [];
  const s = SUBJECT_HEADER.exec(subject);
  if (s?.[2]) found.push({ kind: "breaking", why: `"${s[1]}!:" in the subject` });
  else if (s?.[1] === "feat") found.push({ kind: "feature", why: "feat in the subject" });

  const footer = BREAKING_FOOTER.exec(body);
  if (footer) found.push({ kind: "breaking", why: `"${footer[0].trim()}" footer in the body` });
  for (const m of body.matchAll(BODY_HEADER)) {
    if (m[2]) found.push({ kind: "breaking", why: `"${m[1]}!:" commit inside the body` });
    else if (m[1] === "feat") found.push({ kind: "feature", why: "feat commit inside the body" });
  }

  if (found.length === 0) return { kind: "patch", why: s ? `${s[1]}` : "no conventional prefix" };
  return found.reduce((a, b) => (RANK[b.kind] > RANK[a.kind] ? b : a));
}

/**
 * The pure decision. `commits` are `{ subject, body, sha? }`; `chore(release):` ones are skipped.
 * Throws when nothing is left to classify — there is no release to make.
 */
export function classifyBump(currentVersion, commits) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error(`current version is not X.Y.Z: "${currentVersion}"`);

  const skipped = commits.filter((c) => RELEASE_COMMIT.test(c.subject ?? ""));
  const classified = commits
    .filter((c) => !RELEASE_COMMIT.test(c.subject ?? ""))
    .map((c) => ({ ...c, ...classifyCommit(c) }));
  if (classified.length === 0) {
    throw new Error(
      skipped.length > 0
        ? `only release commits (${skipped.length}) since ${currentVersion} — there is nothing to release.`
        : `no commits since ${currentVersion} — there is nothing to release.`,
    );
  }

  const top = classified.reduce((a, c) => (RANK[c.kind] > RANK[a] ? c.kind : a), "patch");
  const preOneZero = current.major === 0;
  const bump = top === "breaking" ? (preOneZero ? "minor" : "major") : top === "feature" ? "minor" : "patch";

  return {
    bump,
    kind: top,
    preOneZero,
    currentVersion,
    nextVersion: nextVersion(currentVersion, bump),
    commits: classified,
    decidedBy: top === "patch" ? [] : classified.filter((c) => c.kind === top),
    skipped,
  };
}

/** The stderr breakdown, also what release-prepare.yml puts in the run summary. */
export function describe(result, lastTag) {
  const short = (c) => (c.sha ? c.sha.slice(0, 7) : "-------");
  const lines = [`${result.commits.length} commit(s) since ${lastTag} (${result.currentVersion}):`, ""];
  for (const c of result.commits) {
    lines.push(`  ${short(c)}  ${c.kind.padEnd(8)}  ${c.subject}   [${c.why}]`);
  }
  for (const c of result.skipped) lines.push(`  ${short(c)}  skipped   ${c.subject}   [release commit]`);
  lines.push("");
  lines.push(`bump: ${result.bump} — ${result.currentVersion} -> ${result.nextVersion}`);
  if (result.kind === "patch") {
    lines.push("decided by: no feature or breaking commit in range, so a patch");
  } else {
    lines.push(`decided by (${result.kind}):`);
    for (const c of result.decidedBy) lines.push(`  ${short(c)}  ${c.subject}   [${c.why}]`);
  }
  if (result.kind === "breaking" && result.preOneZero) {
    lines.push(
      "note: breaking change while the major version is 0 — held at a minor bump. 1.0.0 is only" +
        " ever an explicit `major` or `version` input.",
    );
  }
  return lines.join("\n");
}

function main(argv) {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const fail = (message) => {
    process.stderr.write(`classify-bump: ${message}\n`);
    process.exit(1);
  };

  let since = null;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--since") since = argv[++i];

  let lastTag;
  let currentVersion;
  if (since) {
    lastTag = since;
    if (parseVersion(since.replace(/^v/, ""))) {
      currentVersion = since.replace(/^v/, "");
    } else {
      try {
        currentVersion = JSON.parse(git("show", `${since}:package.json`)).version;
      } catch {
        fail(`--since ${since}: could not read package.json at that ref.`);
      }
    }
  } else {
    try {
      lastTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD");
    } catch {
      fail(
        "no v* tag is reachable from HEAD, so there is no last release to count from. " +
          "(A shallow clone? The workflow checks out with fetch-depth: 0.) Pass an explicit `version` instead.",
      );
    }
    currentVersion = lastTag.replace(/^v/, "");
    if (!parseVersion(currentVersion)) fail(`the last tag "${lastTag}" is not vX.Y.Z — refusing to guess from it.`);
  }

  // The tag is what shipped; package.json is what main says. They agree except between a
  // prepare PR merging and its tag being pushed — worth saying, because a prepare dispatched in
  // that window would compute from the older number.
  try {
    const onMain = JSON.parse(git("show", "HEAD:package.json")).version;
    if (onMain !== currentVersion) {
      process.stderr.write(
        `classify-bump: warning — package.json at HEAD says ${onMain}, the last tag says ${currentVersion}. ` +
          "Is a prepared release still waiting for its tag?\n",
      );
    }
  } catch {
    /* no package.json at HEAD: nothing to compare */
  }

  let raw;
  try {
    raw = git("log", "--format=%H%x00%s%x00%b%x1e", `${lastTag}..HEAD`);
  } catch {
    fail(`"git log ${lastTag}..HEAD" failed — is "${lastTag}" a commit in this clone?`);
  }
  const commits = raw
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha, subject, body = ""] = r.split("\x00");
      return { sha, subject, body };
    });

  let result;
  try {
    result = classifyBump(currentVersion, commits);
  } catch (e) {
    fail(e.message);
  }

  process.stderr.write(`${describe(result, lastTag)}\n`);
  process.stdout.write(
    [
      `bump=${result.bump}`,
      `next_version=${result.nextVersion}`,
      `commit_count=${result.commits.length}`,
      `last_tag=${lastTag}`,
      `current_version=${currentVersion}`,
      `decided_by=${result.decidedBy.map((c) => c.sha.slice(0, 7)).join(" ")}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
