import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

// `archstone serve --http` end to end (ADD-0008 #29): spawn the real CLI, wait for it to
// bind, then drive it with real HTTP requests (fetch) — no Workers runtime, no mock
// transport. Covers the bearer-token gate (missing/wrong -> 401, no tool leakage) and a real
// initialize -> tools/list round trip. Complements packages/agent/test/mcp.test.ts (which
// exercises mcpHandler()/createHttpHandler directly, in-process) by proving the CLI's
// Node-http adapter (the "~20-line wrapper", D-3) actually works over a real socket.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");

// A per-test-run port, not a fixed one, to keep repeated/parallel runs from colliding.
const PORT = 20000 + (process.pid % 10000);
const BASE = `http://localhost:${PORT}/`;

let child: ChildProcess | undefined;

function startServeHttp(env: Record<string, string | undefined>): Promise<void> {
  return new Promise((res, rej) => {
    child = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT)], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let out = "";
    const onData = (d: Buffer) => {
      out += String(d);
      if (out.includes("serving MCP over HTTP")) {
        child?.stderr?.off("data", onData);
        res();
      }
    };
    child.stderr?.on("data", onData);
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) rej(new Error(`archstone serve --http exited early (code ${code}): ${out}`));
    });
  });
}

afterEach(() => {
  child?.kill();
  child = undefined;
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("archstone serve --http (ADD-0008 #29)", () => {
  it("401s without a bearer token, with no tool information in the body", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const res = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/tourism_search/);
  }, 20000);

  it("401s with the wrong bearer token", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const res = await mcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { authorization: "Bearer wrong" },
    );
    expect(res.status).toBe(401);
  }, 20000);

  it("initialize -> tools/list, with a valid bearer token (ARCHSTONE_HTTP_TOKEN)", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const auth = { authorization: "Bearer demo-secret" };

    const init = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      },
      auth,
    );
    expect(init.status).toBe(200);

    const list = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result?: { tools: { name: string }[] } };
    expect(body.result?.tools.map((t) => t.name)).toContain("tourism_search");
  }, 20000);

  it("a --token flag is accepted in place of the env var", async () => {
    child = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT + 1), "--token", "flag-secret"], {
      cwd: root,
      env: process.env,
    });
    await new Promise<void>((res, rej) => {
      let out = "";
      const onData = (d: Buffer) => {
        out += String(d);
        if (out.includes("serving MCP over HTTP")) {
          child?.stderr?.off("data", onData);
          res();
        }
      };
      child?.stderr?.on("data", onData);
      child?.on("error", rej);
    });
    const res = await fetch(`http://localhost:${PORT + 1}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer flag-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  }, 20000);
});

describe("archstone serve --http — missing bearer token (Rule #7 / R-5)", () => {
  it("exits non-zero and never binds a port when neither --token nor ARCHSTONE_HTTP_TOKEN is set", async () => {
    const { ARCHSTONE_HTTP_TOKEN: _drop, ...envWithoutToken } = process.env;
    const proc = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT + 2)], {
      cwd: root,
      env: envWithoutToken,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((res) => proc.on("exit", res));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/bearer token required/);
  }, 20000);
});
