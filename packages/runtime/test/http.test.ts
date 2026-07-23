import { describe, it, expect, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike, InvokeOptions } from "@archstone/provider-rest";
import { buildRegistry } from "../src/registry";
import { createHttpHandler } from "../src/http";

// createHttpHandler's own bearer-token gate (Rule #7, ADD-0008 R-5). The full Streamable-HTTP
// round trip (initialize → tools/list → tools/call) is #29's DoD — a minimal initialize
// round-trip is enough here to prove a correctly-authenticated request reaches the MCP
// transport at all.

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const bank = resolve(here, "../../../examples/manifests/bank");
const registry = buildRegistry(booking).registry!;
const bankRegistry = buildRegistry(bank).registry!;

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

function callToolRequest(name: string, args: Record<string, unknown> = {}, id = 1): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("createHttpHandler — resolveCaller (ADD-32) — per-request caller, orthogonal to bearerToken", () => {
  it("two sequential requests with different Authorization headers attach two different caller tokens to the outbound backend call", async () => {
    const outboundAuth: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      outboundAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    };
    const handler = createHttpHandler(bankRegistry, {
      bearerToken: "endpoint-secret", // gates the endpoint — orthogonal to resolveCaller (R-2)
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl },
      resolveCaller: (request) => {
        const auth = request.headers.get("x-end-user-token");
        return auth ? { accessToken: auth } : undefined;
      },
    });

    const res1 = await handler(
      mcpRequest(callToolRequest("banking_list-accounts"), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "alice-token",
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await handler(
      mcpRequest(callToolRequest("banking_list-accounts", {}, 2), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "bob-token",
      }),
    );
    expect(res2.status).toBe(200);

    expect(outboundAuth).toEqual(["Bearer alice-token", "Bearer bob-token"]);
  });

  it("a valid bearerToken (endpoint access) does not itself supply a caller — an authenticated capability still fails closed with no resolveCaller", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the caller-less request must fail closed first");
    };
    const handler = createHttpHandler(bankRegistry, {
      bearerToken: "endpoint-secret",
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl },
      // no resolveCaller at all
    });
    const res = await handler(mcpRequest(callToolRequest("banking_list-accounts"), { authorization: "Bearer endpoint-secret" }));
    expect(res.status).toBe(200); // MCP transport itself succeeds; the tool call surfaces isError
    const body = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/requires policies:\[authenticated\]/);
  });
});

// Security-hardening follow-up to ADD-32: `allowedHosts` is a new field on the same
// `InvokeOptions` bag `createHttpHandler` already spreads verbatim into its per-request
// `invoke` object (`{ ...opts.invoke, caller: opts.resolveCaller?.(request) }`, `http.ts`) — so
// this proves that spread carries `allowedHosts` through too, with zero code change in http.ts.
describe("createHttpHandler — allowedHosts pass-through (security hardening)", () => {
  it("allowedHosts set at construction time reaches createMcpServer on every request", async () => {
    vi.resetModules();
    const captured: (InvokeOptions | undefined)[] = [];
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured.push(invoke);
          return actual.createMcpServer(reg as never, invoke);
        },
      };
    });
    try {
      const { createHttpHandler: mockedCreateHttpHandler } = await import("../src/http");
      const allowedHosts = ["tenant-a.core.example.com"];
      const handler = mockedCreateHttpHandler(bankRegistry, {
        bearerToken: "endpoint-secret",
        invoke: { env: { CORE_BANKING_URL: "https://core.example" }, allowedHosts },
      });
      const res = await handler(
        mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: "Bearer endpoint-secret" }),
      );
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.allowedHosts).toEqual(allowedHosts);
    } finally {
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });
});

// Issue #39 / ADD-31: onResponse is one more key inside the same `invoke` bag createHttpHandler
// already spreads verbatim into its per-request invoke object (BR-11/S-US3.2).
describe("createHttpHandler — onResponse pass-through (#39)", () => {
  it("S-US3.2: fires exactly once per bearer-authorized tool call, with the same capabilityId/status/data/durationMs shape", async () => {
    const calls: { capabilityId: string; status: number; data: unknown; durationMs: number }[] = [];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    const handler = createHttpHandler(bankRegistry, {
      bearerToken: "endpoint-secret",
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
      resolveCaller: () => ({ accessToken: "end-user-jwt" }),
    });

    const res = await handler(
      mcpRequest(callToolRequest("banking_list-accounts"), { authorization: "Bearer endpoint-secret" }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].capabilityId).toBe("banking.list-accounts");
    expect(calls[0].status).toBe(200);
    expect(calls[0].data).toEqual({ accounts: [] });
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("a throwing onResponse never affects the HTTP MCP CallResult (S-US4.4 at the HTTP surface)", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    const handler = createHttpHandler(bankRegistry, {
      bearerToken: "endpoint-secret",
      invoke: {
        env: { CORE_BANKING_URL: "https://core.example" },
        fetchImpl,
        onResponse: () => {
          throw new Error("boom");
        },
      },
      resolveCaller: () => ({ accessToken: "end-user-jwt" }),
    });
    const res = await handler(
      mcpRequest(callToolRequest("banking_list-accounts"), { authorization: "Bearer endpoint-secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBeFalsy();
  });
});

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
