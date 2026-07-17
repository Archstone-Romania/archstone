import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

// `archstone verify` end to end: spawn the real CLI against the tourism demo manifest,
// pointed at a mock backend, and assert exit code + printed health status (ADD-18).

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");
const booking = resolve(root, "examples/manifests/booking");

function startMock(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("archstone verify (ADD-18)", () => {
  it("exits 0 and prints green for a clean backend matching the golden fixture", async () => {
    const mock = await startMock({
      stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice, France", pricePerNight: 118, rating: 4.5 }],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(stdout).toMatch(/🟢 tourism\.search/);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("exits 1 and prints red when a required field is missing (drift)", async () => {
    const mock = await startMock({ stays: [{ name: "Hotel Azur", location: "Nice, France" }] }); // no pricePerNight
    try {
      await execFileAsync(tsx, [cli, "verify", tourism], { cwd: root, env: { ...process.env, STAYS_API_URL: mock.url } });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(1);
      expect(e.stdout).toMatch(/🔴 tourism\.search/);
    } finally {
      await mock.close();
    }
  }, 20000);
});

describe("archstone verify --json (ADD-20)", () => {
  it("clean backend + --json → stdout parses as JSON, one entry, exit 0", async () => {
    const mock = await startMock({
      stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice, France", pricePerNight: 118, rating: 4.5 }],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      const doc = JSON.parse(stdout);
      expect(doc.results).toHaveLength(1);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "green" });
    } finally {
      await mock.close();
    }
  }, 20000);

  it("drifted/red backend + --json → exit 1, entry has status: red", async () => {
    const mock = await startMock({ stays: [{ name: "Hotel Azur", location: "Nice, France" }] }); // no pricePerNight
    try {
      await execFileAsync(tsx, [cli, "verify", tourism, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(1);
      const doc = JSON.parse(e.stdout);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "red" });
    } finally {
      await mock.close();
    }
  }, 20000);

  it("manifest with zero contract-bearing bindings + --json → {results: []}, exit 0", async () => {
    const { stdout } = await execFileAsync(tsx, [cli, "verify", booking, "--json"], { cwd: root });
    const doc = JSON.parse(stdout);
    expect(doc).toEqual({ results: [] });
  }, 20000);

  it("invalid manifest + --json → exit 2, error: manifest_invalid, no results key", async () => {
    const badDir = resolve(root, "does-not-exist-manifest-dir");
    try {
      await execFileAsync(tsx, [cli, "verify", badDir, "--json"], { cwd: root });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(2);
      const doc = JSON.parse(e.stdout);
      expect(doc.error).toBe("manifest_invalid");
      expect(doc.results).toBeUndefined();
    }
  }, 20000);

  it("stdout parses as a single JSON document with no interleaved free text (--json flag position independent)", async () => {
    const mock = await startMock({
      stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice, France", pricePerNight: 118, rating: 4.5 }],
    });
    try {
      // flag comes before the directory here, proving argv parsing tolerates either order
      const { stdout } = await execFileAsync(tsx, [cli, "verify", "--json", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(stdout.trim().split("\n")).toHaveLength(1);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("default (non-json) invocation is unchanged", async () => {
    const mock = await startMock({
      stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice, France", pricePerNight: 118, rating: 4.5 }],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(stdout).toMatch(/🟢 tourism\.search/);
      expect(() => JSON.parse(stdout)).toThrow();
    } finally {
      await mock.close();
    }
  }, 20000);
});
