import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// `archstone build` end to end: spawn the real CLI (ADD-0008 #27) and assert the written
// artifact's shape — version:"0", no `contract` key on any tool.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");
const booking = resolve(root, "examples/manifests/booking");

interface IRLike {
  version: string;
  tools: Record<string, unknown>[];
}

describe("archstone build (ADD-0008 #27)", () => {
  it("writes a valid, version:'0', contract-free archstone.ir.json for tourism", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-build-"));
    const outFile = join(dir, "archstone.ir.json");
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "build", tourism, "--out", outFile], { cwd: root });
      expect(stdout).toContain("archstone build");

      const ir = JSON.parse(readFileSync(outFile, "utf8")) as IRLike;
      expect(ir.version).toBe("0");
      expect(ir.tools.length).toBeGreaterThan(0);
      for (const tool of ir.tools) expect(tool).not.toHaveProperty("contract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to ./archstone.ir.json in the CWD when --out is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-build-cwd-"));
    try {
      await execFileAsync(tsx, [cli, "build", booking], { cwd: dir });
      const ir = JSON.parse(readFileSync(join(dir, "archstone.ir.json"), "utf8")) as IRLike;
      expect(ir.version).toBe("0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with diagnostics for an invalid manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-build-invalid-"));
    try {
      await expect(execFileAsync(tsx, [cli, "build", dir], { cwd: root })).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
