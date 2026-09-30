import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// `archstone diff` end to end (ADD-309, #77): spawn the real CLI over built artifacts and
// manifest directories, and pin the exit codes and the `--json` shape. The classification
// itself is `diffIR`'s and is pinned row by row in packages/compiler/test/ir-diff.test.ts.
//
// Same generous per-test timeout as build.test.ts / verify.test.ts (#91, #134): every case
// cold-starts `tsx`.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");

interface ToolLike {
  id: string;
  effect: string;
  lifecycle: string;
  [k: string]: unknown;
}
interface IRLike {
  version: string;
  tools: ToolLike[];
  [k: string]: unknown;
}

/** Run the CLI and return exit code + streams, without throwing on a non-zero exit. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, ...args], { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("archstone diff (ADD-309, #77)", () => {
  let dir: string;
  let built: string;
  let deprecated: string;
  let effectChanged: string;
  let futureVersion: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "archstone-diff-"));
    built = join(dir, "archstone.ir.json");
    await execFileAsync(tsx, [cli, "build", tourism, "--out", built], { cwd: root });
    const ir = JSON.parse(readFileSync(built, "utf8")) as IRLike;
    const variant = (name: string, mutate: (ir: IRLike) => void) => {
      const copy = structuredClone(ir);
      mutate(copy);
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify(copy));
      return file;
    };
    deprecated = variant("deprecated.json", (x) => { x.tools[0]!.lifecycle = "deprecated"; });
    effectChanged = variant("effect.json", (x) => { x.tools[0]!.effect = "write"; x.tools[0]!.lifecycle = "deprecated"; });
    futureVersion = variant("future.json", (x) => { x.version = "1"; });
  }, 30000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("exits 0 with no changes, and says on its first line that declarations were compared", async () => {
    // One side a built artifact, the other the manifest directory it was built from.
    const { code, stdout } = await run(["diff", built, tourism]);
    expect(code).toBe(0);
    expect(stdout.split("\n")[0]).toBe("archstone diff compares declarations, not backends — run 'archstone verify' for the backend.");
    expect(stdout).toContain("no changes");
    expect(stdout).toContain("0 breaking, 0 notable, 0 compatible — exit 0");
  }, 20000);

  it("exits 0 when the only change is notable — notable never fails the gate (D-4)", async () => {
    const { code, stdout } = await run(["diff", built, deprecated]);
    expect(code).toBe(0);
    expect(stdout).toContain("notable    tourism.search — lifecycle changed: stable → deprecated — still invocable");
    expect(stdout).toContain("0 breaking, 1 notable, 0 compatible — exit 0");
  }, 20000);

  it("exits 1 on one breaking change, listing breaking before notable", async () => {
    const { code, stdout } = await run(["diff", built, effectChanged]);
    expect(code).toBe(1);
    const breaking = stdout.indexOf("breaking   tourism.search — effect changed: read → write");
    const notable = stdout.indexOf("notable    tourism.search — lifecycle changed");
    expect(breaking).toBeGreaterThan(-1);
    expect(notable).toBeGreaterThan(breaking);
    expect(stdout).toContain("1 breaking, 1 notable, 0 compatible — exit 1");
  }, 20000);

  it("collapses compatible changes to a count unless --all", async () => {
    const described = join(dir, "described.json");
    const ir = JSON.parse(readFileSync(built, "utf8")) as IRLike;
    ir.tools[0]!.description = "A new description.";
    writeFileSync(described, JSON.stringify(ir));
    const collapsed = await run(["diff", built, described]);
    expect(collapsed.code).toBe(0);
    expect(collapsed.stdout).toContain("compatible 1 change(s) — pass --all to list them");
    const listed = await run(["diff", built, described, "--all"]);
    expect(listed.stdout).toContain("compatible tourism.search — description changed");
    expect(listed.stdout).not.toContain("pass --all");
  }, 30000);

  it("--json prints the IRDiff alone — no aggregate ok, the exit code is the gate", async () => {
    const { code, stdout } = await run(["diff", built, effectChanged, "--json"]);
    expect(code).toBe(1);
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["after", "before", "entries", "summary"]);
    expect(doc).not.toHaveProperty("ok");
    expect(doc.before).toEqual({ company: "wanderlust", version: "0" });
    expect(doc.summary).toEqual({ breaking: 1, notable: 1, compatible: 0 });
    expect(doc.entries).toEqual([
      { severity: "breaking", kind: "effect-changed", capabilityId: "tourism.search", path: "effect", before: "read", after: "write", detail: "effect changed: read → write" },
      {
        severity: "notable",
        kind: "lifecycle-deprecated",
        capabilityId: "tourism.search",
        path: "lifecycle",
        before: "stable",
        after: "deprecated",
        detail: "lifecycle changed: stable → deprecated — still invocable",
      },
    ]);
  }, 20000);

  it("--json carries compatible entries without --all", async () => {
    const described = join(dir, "described-json.json");
    const ir = JSON.parse(readFileSync(built, "utf8")) as IRLike;
    ir.tools[0]!.description = "Another description.";
    writeFileSync(described, JSON.stringify(ir));
    const { code, stdout } = await run(["diff", built, described, "--json"]);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { entries: { kind: string }[] };
    expect(doc.entries.map((e) => e.kind)).toEqual(["description-changed"]);
  }, 20000);

  it("refuses two IRs of different version with exit 2", async () => {
    const { code, stderr } = await run(["diff", built, futureVersion]);
    expect(code).toBe(2);
    expect(stderr).toContain("IR version '0' against IR version '1'");
  }, 20000);

  it("refuses an invalid manifest directory with apply's own messages, exit 2", async () => {
    const empty = mkdtempSync(join(tmpdir(), "archstone-diff-invalid-"));
    try {
      const human = await run(["diff", empty, tourism]);
      expect(human.code).toBe(2);
      expect(human.stderr).toContain("manifest invalid — run 'archstone apply");
      expect(human.stderr).toContain("capabilities.yaml");
      const json = await run(["diff", empty, tourism, "--json"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ error: "manifest_invalid" });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 30000);
});
