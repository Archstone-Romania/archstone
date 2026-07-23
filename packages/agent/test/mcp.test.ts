import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR } from "../src/index";
import { mcpHandler } from "../src/mcp";

// Real Streamable-HTTP round trip against mcpHandler() itself (ADD-0008 #29 DoD) — Web-
// standard Request/Response, no Workers runtime needed (they work identically in Node's test
// runner). Modeled on runtime/test/http.test.ts (the bearer-token gate, already covered at
// the createHttpHandler layer) and examples/demo/remote-mcp-worker/test/worker.test.ts (the
// initialize -> tools/list shape) — extended here with tools/call, since #29 is specifically
// about proving the @archstone/agent/mcp wrapper (fromIR() -> mcpHandler()), not
// re-testing createHttpHandler's own gate logic.

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly. */
function loadArtifact(): unknown {
  const ir = buildRegistry(tourism).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
};

describe("mcpHandler() — real Streamable-HTTP round trip (ADD-0008 #29)", () => {
  it("initialize -> tools/list -> tools/call, with a valid bearer token", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const handler = mcpHandler(archstone, {
      bearerToken: "secret",
      invoke: { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    });
    const auth = { authorization: "Bearer secret" };

    const init = await handler(mcpRequest(INITIALIZE, auth));
    expect(init.status).toBe(200);

    const list = await handler(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result?: { tools: { name: string }[] } };
    const names = listBody.result?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("tourism_search");

    const call = await handler(
      mcpRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tourism_search", arguments: { destination: "Nice" } } },
        auth,
      ),
    );
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
    expect(callBody.result?.isError).toBeFalsy();
    expect(callBody.result?.structuredContent).toEqual({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
    });
  });

  it("401s a request with no Authorization header — no tool information in the body", async () => {
    const archstone = fromIR(loadArtifact());
    const handler = mcpHandler(archstone, { bearerToken: "secret" });
    const res = await handler(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/tourism_search/);
  });

  it("401s a request with the wrong bearer token", async () => {
    const archstone = fromIR(loadArtifact());
    const handler = mcpHandler(archstone, { bearerToken: "secret" });
    const res = await handler(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  // Issue #39 / ADD-31 (BR-15/OQ-4/S-US6.2): mcpHandler is a thin, unchanged wrapper over
  // createHttpHandler — this dedicated test confirms onResponse already works at THIS public
  // export with zero additional code, rather than only inferring it from createHttpHandler's
  // own coverage (a consumer may reach mcpHandler without ever importing createHttpHandler).
  it("S-US6.2: mcpHandler forwards invoke.onResponse into a real tools/call round-trip, firing exactly once", async () => {
    const calls: { capabilityId: string; status: number; data: unknown }[] = [];
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const handler = mcpHandler(archstone, {
      bearerToken: "secret",
      invoke: { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    });
    const auth = { authorization: "Bearer secret" };

    await handler(mcpRequest(INITIALIZE, auth));
    const call = await handler(
      mcpRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tourism_search", arguments: { destination: "Nice" } } },
        auth,
      ),
    );
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as { result?: { isError?: boolean } };
    expect(callBody.result?.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].capabilityId).toBe("tourism.search");
    expect(calls[0].status).toBe(200);
  });

  it("throws at construction when bearerToken is missing/empty (Rule #7 / R-5) — mcpHandler does not relax createHttpHandler's gate", () => {
    const archstone = fromIR(loadArtifact());
    expect(() => mcpHandler(archstone, { bearerToken: "" })).toThrow();
    expect(() => mcpHandler(archstone, { bearerToken: undefined as unknown as string })).toThrow();
  });
});
