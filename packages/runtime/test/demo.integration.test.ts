import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

// The demo, end to end and automated: a real MCP client calls tourism.search,
// which routes through the REST provider to a (mock) backend and returns its data.
// This is the whole payoff path minus the human clicking in Claude Desktop.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");

function startMock(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(
        JSON.stringify({
          stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice, France", pricePerNight: 118, rating: 4.5 }],
        }),
      );
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("demo — full path: MCP call → provider → HTTP backend", () => {
  it("a Claude-style client invokes tourism.search and gets backend results", async () => {
    const mock = await startMock();
    const transport = new StdioClientTransport({
      command: tsx,
      args: [cli, "serve", tourism],
      cwd: root,
      env: { ...getDefaultEnvironment(), STAYS_API_URL: mock.url },
    });
    const client = new Client({ name: "demo", version: "0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["tourism_search"]);

      const result = await client.callTool({
        name: "tourism_search",
        arguments: {
          destination: "Nice",
          dates: { from: "2026-07-01", to: "2026-07-07" },
          travelers: { adults: 2, children: 2 },
        },
      });
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain("Hotel Azur");
    } finally {
      await client.close();
      await mock.close();
    }
  }, 20000);
});
