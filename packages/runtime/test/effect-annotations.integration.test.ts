import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { IR } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import { buildRegistry } from "../src/registry";
import { createHttpHandler } from "../src/http";

// #126 — `effect` reaches the IR and the emitter used to drop it.
//
// `archstone init` refuses to write a manifest without a human-confirmed `effect`, on the
// stated grounds that a wrong one is paid for months later, through an agent, in front of a
// customer. The value was then compiled, carried through the IR, and thrown away one line
// before `tools/list` — so the client's tool-confirmation dialog (the ONLY human-in-the-loop
// mechanism that exists today; `human-approval` is declared and unenforced) could not tell a
// search from a payment.
//
// These assertions are deliberately made through a REAL client round-trip on BOTH transports
// rather than against `toolDefinitions()`'s return value, because the claim under test is
// "the annotation crosses the wire" — a serialization/schema claim as much as a mapping one.
// The reference SDK client parses every `tools/list` result through `ListToolsResultSchema`,
// whose object schemas STRIP unknown keys: a field the SDK does not recognize would vanish
// silently between server and client and an internal-object assertion would never notice.
// Following lifecycle.integration.test.ts's pattern (real CLI subprocess, real MCP client).

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");

/** One capability per `effect`, so a single manifest exercises the whole closed enum. */
const EFFECTS = ["read", "write", "irreversible"] as const;

function writeManifest(dir: string): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    ["company:", "  id: demo", "capabilities:", ...EFFECTS.map((e) => `  - demo.${e}`), "providers:", "  - acme", ""].join("\n"),
  );
  mkdirSync(join(dir, "bindings"));
  for (const e of EFFECTS) {
    writeFileSync(
      join(dir, `demo.${e}.capability.yaml`),
      [
        "capability:",
        `  id: demo.${e}`,
        `  description: A ${e} capability.`,
        `  effect: ${e}`,
        "  provider: acme",
        "  output:",
        "    value:",
        "      type: string",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "bindings", `demo.${e}.binding.yaml`),
      [
        "binding:",
        `  capabilityId: demo.${e}`,
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${DEMO_API_URL}"',
        `      method: ${e === "read" ? "GET" : "POST"}`,
        "      path: /x",
        "",
      ].join("\n"),
    );
  }
}

/** The mapping, restated here independently of the implementation — this is the spec #126
 *  fixed, not a re-derivation of the code. `read` carries NO destructiveHint (the SDK's own
 *  schema documents that field as "meaningful only when readOnlyHint == false"); `write`
 *  carries destructiveHint:false, which is load-bearing rather than redundant because the SDK
 *  documents `destructiveHint` as DEFAULTING TO TRUE when absent. */
const EXPECTED: Record<(typeof EFFECTS)[number], Record<string, boolean>> = {
  read: { readOnlyHint: true },
  write: { destructiveHint: false },
  irreversible: { destructiveHint: true, idempotentHint: false },
};

describe("#126 — tools/list carries effect-derived annotations over stdio", () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "archstone-effect-annotations-"));
    writeManifest(dir);
    const transport = new StdioClientTransport({
      command: tsx,
      args: [cli, "serve", dir],
      cwd: root,
      // No backend is ever contacted: tools/list does no connector work.
      env: { ...getDefaultEnvironment(), DEMO_API_URL: "http://127.0.0.1:1" },
    });
    client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(EFFECTS)("effect: %s maps to exactly its annotation set, as parsed by a real MCP client", async (effect) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === `demo_${effect}`);
    expect(tool, `demo_${effect} must be listed`).toBeDefined();
    // toEqual, not toMatchObject: an annotation we did not decide to emit (openWorldHint, a
    // title, an idempotentHint on `write`) is exactly as much of a defect as a missing one —
    // a client cannot distinguish an invented hint from a fact.
    expect(tool!.annotations).toEqual(EXPECTED[effect]);
  });

  it("does not gate, reorder, or unlist anything on `effect` — all three stay listed (#126: tell the truth, change no behaviour)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["demo_irreversible", "demo_read", "demo_write"]);
  });
});

describe("#126 — the same annotations cross the Streamable-HTTP transport", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "archstone-effect-annotations-http-"));
    writeManifest(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Drives the real `(Request) => Promise<Response>` handler with a real `tools/list` JSON-RPC
   *  request, per http.test.ts — stateless mode, so no `initialize` handshake is required. */
  async function listToolsOverHttp(): Promise<{ name: string; annotations?: Record<string, boolean> }[]> {
    const built = buildRegistry(dir);
    expect(built.ok).toBe(true);
    const handler = createHttpHandler(built.registry!, {
      bearerToken: "endpoint-secret",
      invoke: { env: { DEMO_API_URL: "http://127.0.0.1:1" } },
    });
    const res = await handler(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer endpoint-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: { name: string; annotations?: Record<string, boolean> }[] } };
    return body.result?.tools ?? [];
  }

  it.each(EFFECTS)("effect: %s carries the identical annotation set on HTTP as on stdio", async (effect) => {
    const tools = await listToolsOverHttp();
    const tool = tools.find((t) => t.name === `demo_${effect}`);
    expect(tool, `demo_${effect} must be listed over HTTP`).toBeDefined();
    expect(tool!.annotations).toEqual(EXPECTED[effect]);
  });
});

// #126 / ADD-56 D-1's trust boundary, applied to `effect`. `fromIR` validates only
// `version === "0"` and then casts (`json as IR`), so a hand-written or forward-versioned
// artifact served through `mcpHandler` → `createHttpHandler` → `createMcpServer` reaches
// `toolDefinitions` carrying ANY string in `effect`. The compiler cannot produce this; the
// embedded path can. A Registry built directly over synthetic IR is precisely the object
// `fromIR` hands over, so this reproduces the boundary without depending on @archstone/agent.
describe("#126 — an `effect` this build does not recognize claims nothing at all", () => {
  it("emits no annotations rather than any positive claim — the client falls back to MCP's own cautious defaults", async () => {
    const forwardVersioned = {
      version: "0",
      company: { id: "demo" },
      resources: {},
      tools: [
        {
          id: "demo.future",
          description: "A capability from a newer CDL than this build.",
          // Not a member of the closed union — only reachable across the fromIR cast.
          effect: "quantum-entangling",
          provider: "acme",
          policies: [],
          lifecycle: "stable",
          input: [],
          output: [],
          connector: { type: "rest", rest: { method: "GET", path: "/x" } },
        },
      ],
    };
    const handler = createHttpHandler(new Registry(forwardVersioned as unknown as IR), { bearerToken: "endpoint-secret" });
    const res = await handler(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer endpoint-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const body = (await res.json()) as { result?: { tools?: { name: string; annotations?: unknown }[] } };
    const tool = body.result?.tools?.find((t) => t.name === "demo_future");
    expect(tool, "the tool is still listed — #126 changes no behaviour").toBeDefined();
    // The one outcome that must never be reachable from an unrecognized value is
    // `readOnlyHint: true`; absent annotations is the only answer that guarantees it, and it
    // leaves the client on MCP's documented defaults (readOnlyHint false, destructiveHint true).
    expect(tool!.annotations).toBeUndefined();
  });
});
