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
