import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// `archstone apply --exposure [--json]` (ADD-309 §7 step 4), end to end through the real CLI.
//
// The committed reports under fixtures/reports/ are the point, not a convenience:
//   - apply-tourism.txt / apply-bank.txt were captured from `apply` BEFORE `--exposure` existed,
//     so "without the flag, apply is byte-identical to today" is checked against the old output
//     itself rather than against whatever the new code happens to print;
//   - tourism.exposure.{txt,json} are the README's "the model is shown these, never these" claim
//     for the demo manifest, reproducible by anyone running the same command.
// They live beside the CLI's tests rather than in examples/manifests/tourism because that
// directory is a manifest — loaded by `apply`, copied by users as a starting point — and a
// rendered report is output of the CLI, pinned by the CLI's test.
//
// To re-record after a deliberate change to the tourism manifest or the rendering:
//   pnpm apply examples/manifests/tourism --exposure        > packages/cli/test/fixtures/reports/tourism.exposure.txt
//   pnpm apply examples/manifests/tourism --exposure --json > packages/cli/test/fixtures/reports/tourism.exposure.json
// (strip pnpm's own banner lines, or run `node_modules/.bin/tsx packages/cli/src/index.ts` directly).

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const reports = resolve(here, "fixtures/reports");
const fixture = (name: string) => readFileSync(join(reports, name), "utf8");

// Relative, from the repo root: `apply` prints the directory as typed, and the fixtures do too.
const run = (...args: string[]) => execFileAsync(tsx, [cli, ...args], { cwd: root });

describe("archstone apply without --exposure is unchanged", () => {
  for (const name of ["tourism", "bank"]) {
    it(`${name}: prints exactly what it printed before the flag existed`, async () => {
      const { stdout, stderr } = await run("apply", `examples/manifests/${name}`);
      expect(stdout).toBe(fixture(`apply-${name}.txt`));
      expect(stderr).toBe("");
    }, 20000);

    it(`${name}: --json alone still changes nothing — apply has no structured form outside --exposure`, async () => {
      const { stdout } = await run("apply", `examples/manifests/${name}`, "--json");
      expect(stdout).toBe(fixture(`apply-${name}.txt`));
    }, 20000);
  }
});

describe("archstone apply --exposure", () => {
  it("renders the tourism report after the registry line, as committed", async () => {
    const { stdout } = await run("apply", "examples/manifests/tourism", "--exposure");
    expect(stdout).toBe(fixture("tourism.exposure.txt"));
    // The report is one block inserted after the registry line: cut it out and what remains is,
    // byte for byte, what `apply` printed before the flag existed.
    const lines = stdout.split("\n");
    const start = lines.findIndex((l) => l.startsWith("  exposure")) - 1;
    const end = lines.findIndex((l) => l.startsWith("  → run 'archstone serve")) - 1;
    expect(lines[start - 1]).toMatch(/^ {2}registry {3}IR v0/);
    expect([...lines.slice(0, start), ...lines.slice(end)].join("\n")).toBe(fixture("apply-tourism.txt"));
  }, 20000);

  it("names what is withheld, and where the observation came from", async () => {
    const { stdout } = await run("apply", "examples/manifests/tourism", "--exposure");
    for (const f of ["$.stays[].net (number)", "$.stays[].commission (number)", "$.stays[].boardType (string)"]) expect(stdout).toContain(f);
    expect(stdout).toContain("as observed in fixtures/tourism.search.golden.json (sha256:f5475f…)");
  }, 20000);

  it("says 'unknown — no recorded contract', never an empty list, where there is none", async () => {
    const { stdout } = await run("apply", "examples/manifests/bank", "--exposure");
    expect(stdout).toContain("withholds  unknown — no recorded contract");
    expect(stdout).not.toContain("withholds  nothing");
    // A binding with no response:/extract: is raw pass-through, and the report says so.
    expect(stdout).toContain("the provider's whole response body");
  }, 20000);
});

describe("archstone apply --exposure --json", () => {
  it("prints { exposure } alone on stdout — one parseable document, nothing else", async () => {
    const { stdout, stderr } = await run("apply", "examples/manifests/tourism", "--exposure", "--json");
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["exposure"]);
    expect(doc).toEqual(JSON.parse(fixture("tourism.exposure.json")));
    expect(stderr).toBe("");
  }, 20000);

  it("the committed JSON: five fields shown, the ADD-114 vocabulary withheld", () => {
    const [search] = (JSON.parse(fixture("tourism.exposure.json")) as { exposure: { exposes: { path: string }[]; withholds: { path: string }[] }[] }).exposure;
    expect(search.exposes.map((e) => e.path)).toEqual(["stays[].location", "stays[].name", "stays[].pricePerNight", "stays[].rating", "totalMatches"]);
    expect(search.withholds.map((w) => w.path)).toEqual([
      "$.stays[].boardType",
      "$.stays[].commission",
      "$.stays[].freeCancellationUntil",
      "$.stays[].id",
      "$.stays[].net",
      "$.stays[].roomDescription",
    ]);
  });

  it("an invalid manifest: nothing on stdout, the reason on stderr, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-exposure-"));
    try {
      writeFileSync(join(dir, "capabilities.yaml"), "company: {}\ncapabilities: [nope.missing]\n");
      const err = (await run("apply", dir, "--exposure", "--json").catch((e: unknown) => e)) as { code: number; stdout: string; stderr: string };
      expect(err.code).toBe(1);
      expect(err.stdout).toBe("");
      expect(err.stderr).toContain(`archstone apply ${dir}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
