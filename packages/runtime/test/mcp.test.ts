import { describe, it, expect, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRegistry } from "../src/registry";
import { toolDefinitions, callTool, createMcpServer } from "../src/mcp";
import type { FetchLike, InvokeOptions } from "@archstone/provider-rest";

// The pure lowering unit tests (toolName, inputJsonSchema field-kind coverage, the
// objectJsonSchema resource cycle-guard) moved to @archstone/emitter-support (ADD-0008 #27)
// along with the code — packages/emitter-support/test/lowering.test.ts. This file keeps the
// tests that exercise runtime-specific behavior (toolDefinitions/callTool/createMcpServer
// routing through a real Registry/REST provider/MCP SDK).

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const tourism = resolve(here, "../../../examples/manifests/tourism");
const bank = resolve(here, "../../../examples/manifests/bank");
const registry = buildRegistry(booking).registry!;

describe("toolDefinitions — IR → MCP tools", () => {
  const defs = toolDefinitions(registry);

  it("emits only bound capabilities as tools", () => {
    // booking has 4 capabilities but only tourism.search is bound
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("tourism_search");
  });

  it("lowers semantic input to JSON Schema", () => {
    const schema = defs[0].inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["destination", "dates", "travelers", "preferences"]),
    );
    expect(schema.required).toContain("destination"); // required semantic field
    expect(schema.required ?? []).not.toContain("preferences"); // required: false in CDL
    expect(schema.properties.destination.type).toBe("string"); // location → string
    expect(schema.properties.dates.type).toBe("object"); // date-range → object
  });
});

describe("#11: outputSchema — typed, described resource lowering", () => {
  const defs = toolDefinitions(buildRegistry(tourism).registry!);
  const search = defs.find((d) => d.name === "tourism_search")!;

  it("emits an outputSchema; collection Stay → array of typed Stay objects", () => {
    const out = search.outputSchema as {
      type: string;
      properties: Record<string, { type: string; items?: { type: string; properties: Record<string, { type: string; description?: string }> } }>;
    };
    expect(out.type).toBe("object");
    const stays = out.properties.stays;
    expect(stays.type).toBe("array");
    // items carry Stay's typed properties — NOT a bare { type: object }.
    const item = stays.items!;
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties)).toEqual(expect.arrayContaining(["name", "location", "pricePerNight", "rating"]));
    expect(item.properties.location.type).toBe("string"); // location semantic → string
    expect(item.properties.location.description).toMatch(/city|region|address/i); // described
  });
});

describe("callTool — routing to the REST provider", () => {
  it("invokes the backend and returns its response as content", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    const r = await callTool(
      registry,
      "tourism_search",
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("hotels");
    // #11 R-4: the raw body is surfaced verbatim as structuredContent (pass-through, unmapped).
    expect(r.structuredContent).toEqual({ hotels: [{ id: "h1" }] });
  });

  it("returns an error for an unknown tool", async () => {
    const r = await callTool(registry, "does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });

  it("does not resolve an unbound capability's tool name (NF-6)", async () => {
    // tourism.book exists in booking but has no binding, so it is never emitted
    // as a tool; its sanitized name must be treated as unknown, not routed.
    expect(registry.getCapability("tourism.book")).toBeDefined();
    expect(toolDefinitions(registry).map((d) => d.name)).not.toContain("tourism_book");

    const r = await callTool(registry, "tourism_book", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });
});

describe("callTool — response mapping (ADD-12, tourism binding has a response:)", () => {
  const tourismReg = buildRegistry(tourism).registry!;

  it("maps the provider body to Stay and drops unmapped fields (structuredContent = outputSchema)", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    // `id` is not part of Stay → dropped by the mapping; structuredContent is the mapped shape.
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] });
  });

  it("fails closed on a missing REQUIRED field — no raw pass-through (D-6)", async () => {
    // pricePerNight (required) absent → VIOLATION; the raw body must NOT leak through.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }] }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/contract violation/i);
    expect(r.content[0].text).toMatch(/pricePerNight/);
    // #19 BR-4/US-2: the text message names the violating capability id too.
    expect(r.content[0].text).toContain("tourism.search");
    // #19 ADD-19 Rev 2 D-3′: structuredContent stays absent on VIOLATION — a client-side
    // schema-validating regression guard (a non-empty structuredContent here would crash the
    // reference SDK client, since it doesn't conform to the tool's outputSchema).
    expect(r.structuredContent).toBeUndefined();
    // #19 ADD-19 Rev 2 D-6: the structured, machine-readable error object moves to `_meta`.
    expect(r._meta?.["dev.archstone/contract_violation"]).toEqual({
      error: "contract_violation",
      capability: "tourism.search",
      missing: ["pricePerNight"],
    });
  });

  it("dedups the structured missing list across multiple violating collection items (BR-8/S-US1.6)", async () => {
    // item 1 is missing pricePerNight; item 2 is missing location — both required, both
    // fields must appear exactly once in structuredContent.missing, order-independent.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          stays: [
            { name: "Hotel Azur", location: "Nice" },
            { name: "Hotel Riviera", pricePerNight: 200 },
          ],
        }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const structured = r._meta?.["dev.archstone/contract_violation"] as { error: string; capability: string; missing: string[] };
    expect(structured.error).toBe("contract_violation");
    expect(structured.capability).toBe("tourism.search");
    expect([...structured.missing].sort()).toEqual(["location", "pricePerNight"]);
  });

  it("degrades on a missing OPTIONAL field — result returned with a note", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] });
    expect(r.content.some((c) => /degraded/i.test(c.text))).toBe(true);
  });
});

describe("#19 ADD-19 Rev 2 R2.2/R2.7 step 4 — a real SDK Client survives a VIOLATION result", () => {
  // This is the actual regression test for the bug that blocked Rev 1: the crash happened
  // inside the CLIENT's callTool() (it schema-validates structuredContent against the
  // advertised outputSchema whenever one is declared, unconditionally on isError), not the
  // server's. A unit test calling the exported `callTool` function directly cannot see that —
  // it has to go through a real Client instance talking to a real Server, in-process, over the
  // SDK's own InMemoryTransport, exactly as the architect reproduced it in R2.2.
  const tourismReg = buildRegistry(tourism).registry!;

  it("does not throw on VIOLATION, and the structured error survives in result._meta", async () => {
    // pricePerNight (required) is absent from the mock backend body → VIOLATION.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }] }), { status: 200 });
    const server = createMcpServer(tourismReg, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // Call listTools() first so the client caches an outputSchema validator for
      // tourism_search, the same way it does in production — this is what arms the
      // validation path that crashed under Rev 1's structuredContent-based mechanism.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("tourism_search");

      const result = await client.callTool({ name: "tourism_search", arguments: { destination: "Nice" } });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result._meta?.["dev.archstone/contract_violation"]).toEqual({
        error: "contract_violation",
        capability: "tourism.search",
        missing: ["pricePerNight"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("serveStdio — forwards `invoke` to createMcpServer (ADD-32 step 5)", () => {
  // serveStdio itself connects a real StdioServerTransport (reads process.stdin) and blocks
  // on server.connect() — not something a unit test should exercise directly (no in-process
  // way to end that without touching real stdin, and no existing test does). Mock both the
  // SDK's stdio transport and this module's own createMcpServer so this test proves exactly
  // one thing — the `invoke` param, once added, reaches createMcpServer verbatim — without
  // ever opening a real stdio channel.
  it("passes the invoke option through to createMcpServer, unlike before #32 (no InvokeOptions could ever reach it)", async () => {
    vi.resetModules();
    let captured: InvokeOptions | undefined;
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured = invoke;
          return { connect: async () => {} } as unknown as ReturnType<typeof actual.createMcpServer>;
        },
      };
    });
    try {
      const { serveStdio } = await import("../src/mcp");
      const caller = { accessToken: "static-per-process-token" };
      await serveStdio(bank, { env: { CORE_BANKING_URL: "https://core.example" }, caller });
      expect(captured?.caller).toEqual(caller);
    } finally {
      vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });

  // Security-hardening follow-up to ADD-32: `allowedHosts` is a NEW field on the same
  // `InvokeOptions` bag the test above already proves is forwarded verbatim, unchanged — so
  // this test only needs to confirm the same pass-through covers the new field too, with zero
  // code change in mcp.ts (serveStdio forwards `invoke` as a whole, never destructures it).
  it("passes InvokeOptions.allowedHosts through to createMcpServer as part of the same verbatim forward", async () => {
    vi.resetModules();
    let captured: InvokeOptions | undefined;
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured = invoke;
          return { connect: async () => {} } as unknown as ReturnType<typeof actual.createMcpServer>;
        },
      };
    });
    try {
      const { serveStdio } = await import("../src/mcp");
      const allowedHosts = ["tenant-a.core.example.com"];
      await serveStdio(bank, { env: { CORE_BANKING_URL: "https://core.example" }, allowedHosts });
      expect(captured?.allowedHosts).toEqual(allowedHosts);
    } finally {
      vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });
});

describe("ADD-32 step 9 — a tool call reaches a real backend with the CALLER token attached, not ${API_KEY}", () => {
  // A genuine end-to-end path: a real MCP Client, over the SDK's own InMemoryTransport, talking
  // to createMcpServer(bankRegistry, { caller }) — which in turn makes a REAL network request
  // (node:http, not an injected fetchImpl stub) to a local mock backend. Proves banking.
  // list-accounts' ${caller.accessToken} placeholder — not an env var — is what the backend
  // actually receives.
  function startMock(): Promise<{ url: string; close: () => Promise<void>; authHeaders: string[] }> {
    const authHeaders: string[] = [];
    return new Promise((res) => {
      const server = createServer((req, resp) => {
        authHeaders.push(req.headers.authorization ?? "");
        resp.setHeader("content-type", "application/json");
        resp.end(
          JSON.stringify({
            accounts: [{ number: "IBAN123", currency: "EUR", balance: { amount: 100, currency: "EUR" }, status: "active" }],
          }),
        );
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        res({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), authHeaders });
      });
    });
  }

  it("banking.list-accounts: the backend receives 'Bearer <caller token>', never a service-account env var", async () => {
    const bankRegistry = buildRegistry(bank).registry!;
    const mock = await startMock();
    const server = createMcpServer(bankRegistry, {
      env: { CORE_BANKING_URL: mock.url }, // deliberately NOT an API key — nothing else is set
      caller: { accessToken: "end-user-jwt-xyz" },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("banking_list-accounts");

      const result = await client.callTool({ name: "banking_list-accounts", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(mock.authHeaders).toEqual(["Bearer end-user-jwt-xyz"]);
    } finally {
      await client.close();
      await server.close();
      await mock.close();
    }
  });

  it("with no caller supplied, the same tool call fails closed and the mock backend never receives a request", async () => {
    const bankRegistry = buildRegistry(bank).registry!;
    const mock = await startMock();
    const server = createMcpServer(bankRegistry, { env: { CORE_BANKING_URL: mock.url } }); // no caller

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "banking_list-accounts", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toMatch(/requires policies:\[authenticated\]/);
      expect(mock.authHeaders).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
      await mock.close();
    }
  });
});
