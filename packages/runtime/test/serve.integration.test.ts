import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end: spawn `archstone serve` and drive it with a real MCP client over
// stdio — the same channel Claude Desktop uses. Proves discovery works, not just
// the pure emitter functions.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../.."); // repo root
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const booking = resolve(root, "examples/manifests/booking");

describe("archstone serve — real MCP handshake over stdio", () => {
  it("a client discovers the emitted tools", async () => {
    const transport = new StdioClientTransport({ command: tsx, args: [cli, "serve", booking], cwd: root });
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["tourism_search"]);
      expect((tools[0].inputSchema as { type: string }).type).toBe("object");
    } finally {
      await client.close();
    }
  }, 20000);
});

describe("#16 NF-7: serveStdio error path — invalid manifest dir", () => {
  it("exits non-zero and logs the error to stderr", async () => {
    const badDir = resolve(root, "does-not-exist-manifest-dir");
    const { code, stderr } = await run(tsx, [cli, "serve", badDir]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/cannot serve|invalid|no such|not/i);
    expect(stderr).toContain(badDir);
  }, 20000);
});

// Spawn the CLI and collect its exit code + stderr (stdout is the MCP channel).
function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { cwd: root });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stderr }));
  });
}
