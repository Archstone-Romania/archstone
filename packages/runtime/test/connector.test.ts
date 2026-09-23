import { describe, it, expect } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeConnector } from "../src/connector";

// ADR-0012 D-6 — centralized connector dispatch. No call site branches on
// `tool.connector?.type` independently any more; this is the one place that does.

const base: Omit<IRTool, "connector"> = {
  id: "x.y",
  description: "",
  effect: "read",
  provider: "",
  policies: [],
  lifecycle: "stable",
  input: [],
  output: [],
};

describe("invokeConnector", () => {
  it("dispatches a rest connector to invokeRest", async () => {
    const tool: IRTool = { ...base, connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "GET", path: "/x" } } };
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const result = await invokeConnector(tool, {}, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it("dispatches a sql connector to invokeSql", async () => {
    const tool: IRTool = {
      ...base,
      connector: { type: "sql", sql: { engine: "postgres", dsn: "${DATABASE_URL}", statementKind: "select", query: "SELECT 1", params: [] } },
    };
    const result = await invokeConnector(tool, {}, {}); // no identityAdapter configured
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no session identity resolved/);
  });

  it("returns 'connector type not implemented' for graphql/grpc/soap — one consistent shape (S-US10.3)", async () => {
    for (const type of ["graphql", "grpc", "soap"] as const) {
      const tool: IRTool = { ...base, connector: { type } };
      const result = await invokeConnector(tool, {}, {});
      expect(result).toEqual({ ok: false, status: 0, error: `capability 'x.y': connector type '${type}' is not implemented` });
    }
  });

  it("returns a clean 'has no connector' result when the tool has no connector at all", async () => {
    const tool: IRTool = { ...base };
    const result = await invokeConnector(tool, {}, {});
    expect(result).toEqual({ ok: false, status: 0, error: "capability 'x.y' has no connector" });
  });
});
