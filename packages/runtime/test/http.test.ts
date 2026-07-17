import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../src/registry";
import { createHttpHandler } from "../src/http";

// createHttpHandler's own bearer-token gate (Rule #7, ADD-0008 R-5). The full Streamable-HTTP
// round trip (initialize → tools/list → tools/call) is #29's DoD — a minimal initialize
// round-trip is enough here to prove a correctly-authenticated request reaches the MCP
// transport at all.

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const registry = buildRegistry(booking).registry!;

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("createHttpHandler — bearer-token gate", () => {
  it("throws at construction when bearerToken is missing/empty", () => {
    expect(() => createHttpHandler(registry, { bearerToken: "" })).toThrow();
    expect(() => createHttpHandler(registry, { bearerToken: undefined as unknown as string })).toThrow();
  });

  it("401s a request with no Authorization header, with no tool information in the body", async () => {
    const handler = createHttpHandler(registry, { bearerToken: "secret" });
    const res = await handler(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/tourism_search/);
  });

  it("401s a request with the wrong bearer token", async () => {
    const handler = createHttpHandler(registry, { bearerToken: "secret" });
    const res = await handler(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  it("reaches the MCP transport with the right token (initialize round-trip)", async () => {
    const handler = createHttpHandler(registry, { bearerToken: "secret" });
    const res = await handler(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
        },
        { authorization: "Bearer secret" },
      ),
    );
    expect(res.status).toBe(200);
  });
});
