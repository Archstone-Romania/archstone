import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HEALTH_SNAPSHOT_FILE } from "../src/registry";

// ADD-24 (#24): end-to-end, real-CLI-over-stdio coverage of lifecycle listing/invocation and
// the health-snapshot hint path — the two integration scenarios ADD-24 §7 step 10 calls for,
// on top of exposure.test.ts's/registry.test.ts's pure-function and Registry-composition unit
// coverage. Follows demo.integration.test.ts's pattern: a synthetic manifest written to a temp
// dir (no mocking of the pipeline itself — a real CLI subprocess, a real MCP client, a real
// (mock) HTTP backend).

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");

/** One capability per lifecycle state, all bound to the same mock backend, so a single
 *  manifest exercises every listed/invocable/hint combination `serve` must honor. */
const LIFECYCLES = ["stable", "beta", "deprecated", "experimental", "retired"] as const;

function writeManifest(dir: string): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    [
      "company:",
      "  id: demo",
      "capabilities:",
      ...LIFECYCLES.map((l) => `  - demo.${l}`),
      "providers:",
      "  - acme",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "bindings"));
  for (const l of LIFECYCLES) {
    writeFileSync(
      join(dir, `demo.${l}.capability.yaml`),
      [
        "capability:",
        `  id: demo.${l}`,
        `  description: A ${l} capability.`,
        "  effect: read",
        "  provider: acme",
        `  lifecycle: ${l}`,
        "  output:",
        "    value:",
        "      type: string",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "bindings", `demo.${l}.binding.yaml`),
      [
        "binding:",
        `  capabilityId: demo.${l}`,
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${DEMO_API_URL}"',
        "      method: GET",
        "      path: /x",
        "",
      ].join("\n"),
    );
  }
}

function startMock(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server: Server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify({ value: "ok" }));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function connect(dir: string, apiUrl: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [cli, "serve", dir],
    cwd: root,
    env: { ...getDefaultEnvironment(), DEMO_API_URL: apiUrl },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("ADD-24 — lifecycle listing + invocation over a real MCP stdio server", () => {
  let dir: string;
  let mock: { url: string; close: () => Promise<void> };
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "archstone-lifecycle-"));
    writeManifest(dir);
    mock = await startMock();
    client = await connect(dir, mock.url);
  }, 20000);

  afterAll(async () => {
    await client.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tools/list carries exactly stable, beta, deprecated — retired and experimental are unlisted (D-10)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["demo_beta", "demo_deprecated", "demo_stable"]);
  });

  it("stable has no hint; beta/deprecated carry their lifecycle hint text in the description", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get("demo_stable")).toBe("A stable capability.");
    expect(byName.get("demo_beta")).toContain("beta");
    expect(byName.get("demo_deprecated")).toContain("deprecated");
  });

  it("experimental is unlisted but still invocable by its (sanitized) name — 'opt-in by knowing it' (D-10)", async () => {
    const result = await client.callTool({ name: "demo_experimental", arguments: {} });
    expect(result.isError).toBe(false);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("ok");
  });

  it("retired is unlisted AND rejects callTool via a namespaced _meta key, never structuredContent (D-11)", async () => {
    const result = await client.callTool({ name: "demo_retired", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.["dev.archstone/lifecycle_blocked"]).toEqual({
      error: "lifecycle_blocked",
      capability: "demo.retired",
      lifecycle: "retired",
    });
  });
});

describe("ADD-24 — binding-health snapshot composes a hint into tools/list (D-8/D-9)", () => {
  let dir: string;
  let mock: { url: string; close: () => Promise<void> };
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "archstone-lifecycle-health-"));
    writeManifest(dir);
    // Simulate an operator/CI redirecting `archstone verify --json` into the conventional
    // snapshot path (ADD-24 D-8) — the exact `{results: ToolVerification[]}` shape `verify`
    // already produces, no new serialization.
    writeFileSync(
      join(dir, HEALTH_SNAPSHOT_FILE),
      JSON.stringify({
        results: [{ capabilityId: "demo.stable", status: "yellow", detail: "degraded: optional field(s) absent" }],
      }),
    );
    mock = await startMock();
    client = await connect(dir, mock.url);
  }, 20000);

  afterAll(async () => {
    await client.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a stable (no lifecycle hint) tool with yellow health picks up a caution hint from the snapshot", async () => {
    const { tools } = await client.listTools();
    const stable = tools.find((t) => t.name === "demo_stable");
    expect(stable?.description).toContain("binding health: yellow");
  });

  it("never gates invocation — the yellow tool is still both listed and callable", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("demo_stable");
    const result = await client.callTool({ name: "demo_stable", arguments: {} });
    expect(result.isError).toBe(false);
  });
});
