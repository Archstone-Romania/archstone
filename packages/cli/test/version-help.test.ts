import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

// `archstone --version` and `--help` are the first two things a human types after installing.
// Both used to fall through to the no-verb-matched branch: usage on stderr, exit 2 — a non-zero
// exit for a question the CLI answered correctly, which reads as a broken install at the exact
// moment a new user is deciding whether this works. Found running the published 0.11.2 through a
// clean-machine install while preparing the M6 launch.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const pkgVersion = (
  JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8")) as { version: string }
).version;

describe("archstone --version", () => {
  for (const flag of ["--version", "-V"]) {
    it(`${flag} prints the package version on stdout and exits 0`, async () => {
      const { stdout, stderr } = await execFileAsync(tsx, [cli, flag], { cwd: root });
      expect(stdout.trim()).toBe(pkgVersion);
      expect(stderr).toBe("");
    }, 20000);
  }

  it("reports a real semver, never the 'unknown' fallback, from the shipped layout", async () => {
    const { stdout } = await execFileAsync(tsx, [cli, "--version"], { cwd: root });
    // The fallback exists so a version lookup can never be what stops the CLI running — but if
    // it ever fires in the normal layout, `../package.json` resolution has broken and every
    // published `--version` would read "unknown".
    expect(stdout.trim()).not.toBe("unknown");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 20000);
});

describe("archstone --help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`${flag} prints usage on STDOUT and exits 0 — the user asked for it`, async () => {
      const { stdout } = await execFileAsync(tsx, [cli, flag], { cwd: root });
      expect(stdout).toContain("usage: archstone");
      expect(stdout).toContain("--version");
    }, 20000);
  }
});

describe("the no-verb-matched fallthrough is unchanged", () => {
  it("still prints usage on STDERR and still exits 2", async () => {
    // The distinction this pins: `--help` is a question answered (stdout, 0); an unrecognized
    // invocation is an error (stderr, 2). One usage string, two dispositions — regressing
    // either one back into the other is the failure this guards.
    await expect(execFileAsync(tsx, [cli, "not-a-verb"], { cwd: root })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("usage: archstone"),
    });
  }, 20000);
});
