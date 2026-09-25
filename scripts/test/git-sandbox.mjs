// A throwaway git repository for the node:test suites of the scripts that read git history
// (check-changelog-entry, check-changelog-history, classify-bump).
//
// Those scripts are judged by what they say about a RANGE of commits, and this repository's own
// history is the wrong fixture for that: it grows under the tests, it has none of the shapes
// the tests need (a waiver trailer, a rebase that reattached an entry), and a shallow CI clone
// may not have it at all. So each test builds exactly the history it is about, in a temp dir.
//
// The user's own git configuration is shut out — no global or system config, fixed identity —
// because a signing requirement, a hook path or a `init.defaultBranch` on the machine running
// the tests would otherwise change what these repositories look like, or fail to build them.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, devNull } from "node:os";

export function sandbox(prefix = "archstone-git-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) delete env[k];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });

  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "-q", "-b", "main");

  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  return {
    dir,
    env,
    git,
    write,
    /** Write `files` (path -> text), commit everything with `message`, return the new SHA. */
    commit(message, files = {}) {
      for (const [file, text] of Object.entries(files)) write(file, text);
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
