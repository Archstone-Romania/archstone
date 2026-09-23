import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeSql, type PgPool, type PgPoolClient, type ConnectionEntry } from "../src/index";

const tool: IRTool = {
  id: "reporting.portfolio-summary",
  description: "Portfolio summary.",
  effect: "read",
  provider: "warehouse",
  policies: [],
  input: [{ name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } }],
  output: [],
  connector: {
    type: "sql",
    sql: {
      engine: "postgres",
      dsn: "${DATABASE_URL}",
      statementKind: "select",
      query: "SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1",
      params: ["id"],
    },
  },
};

/** A fake pool that records every query issued against it — no real Postgres involved. */
function fakePool(rows: Array<Record<string, unknown>>, roleRow?: Record<string, unknown>) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const released = vi.fn();
  const client: PgPoolClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes("pg_roles") && text.includes("rolsuper")) {
        return { rows: roleRow ? [roleRow] : [{ rolsuper: false, rolbypassrls: false }] };
      }
      if (text.includes("role_table_grants")) {
        return { rows: [] }; // no owned-and-granted relation by default
      }
      if (text === "SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1") {
        return { rows };
      }
      return { rows: [] };
    }),
    release: released,
  };
  const pool: PgPool = { connect: vi.fn(async () => client) };
  return { pool, client, queries, released };
}

function baseOpts(pool: PgPool, extra: Record<string, unknown> = {}) {
  return {
    env: { DATABASE_URL: "postgres://runtime@localhost/app" },
    pgPoolFactory: () => pool,
    connectionRegistry: new Map<string, ConnectionEntry>(),
    identityAdapter: (principal: string | undefined) => (principal === "tenant-a" ? { tenantId: "acme" } : undefined),
    caller: { principal: "tenant-a" },
    ...extra,
  };
}

describe("invokeSql — D-4 transaction mechanics", () => {
  it("runs BEGIN, SET TRANSACTION READ ONLY, set_config per claim, the query, COMMIT, then releases", async () => {
    const { pool, queries, released } = fakePool([{ id: "1", headline: "Q1" }]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: true, status: 200, data: [{ id: "1", headline: "Q1" }] });
    // The first connection checkout runs D-9's over-privileged check (pg_roles, then the
    // ownership query) — cached thereafter. The transaction itself is a SECOND checkout.
    const texts = queries.map((q) => q.text);
    const beginIdx = texts.indexOf("BEGIN");
    expect(beginIdx).toBeGreaterThan(0);
    expect(texts[beginIdx + 1]).toBe("SET TRANSACTION READ ONLY");
    expect(texts[beginIdx + 2]).toBe("SELECT set_config($1, $2, true)");
    expect(queries[beginIdx + 2].params).toEqual(["app.tenantId", "acme"]);
    expect(texts[beginIdx + 3]).toBe("SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1");
    expect(queries[beginIdx + 3].params).toEqual(["1"]);
    expect(texts[beginIdx + 4]).toBe("COMMIT");
    // Released once for the check's own connection, once for the transaction's.
    expect(released).toHaveBeenCalledTimes(2);
  });

  it("honors a custom sqlSessionGucPrefix", async () => {
    const { pool, queries } = fakePool([]);
    await invokeSql(tool, { id: "1" }, baseOpts(pool, { sqlSessionGucPrefix: "custom." }));
    const setConfig = queries.find((q) => q.text === "SELECT set_config($1, $2, true)");
    expect(setConfig?.params).toEqual(["custom.tenantId", "acme"]);
  });

  it("rolls back and returns a failure on a query error, and still releases the connection", async () => {
    const released = vi.fn();
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_roles")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes("role_table_grants")) return { rows: [] };
        if (text === "BEGIN" || text === "SET TRANSACTION READ ONLY" || text === "ROLLBACK") return { rows: [] };
        if (text === "SELECT set_config($1, $2, true)") return { rows: [] };
        throw new Error("relation does not exist");
      }),
      release: released,
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/query failed: relation does not exist/);
    expect(released).toHaveBeenCalledTimes(2); // the check's connection, and the transaction's
  });
});

describe("invokeSql — D-3 identity-adapter fail-closed gate", () => {
  it("refuses before any connection is used when identityAdapter is unset", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map(),
      caller: { principal: "tenant-a" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses before any connection is used when identityAdapter cannot resolve this principal", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { caller: { principal: "unknown-session" } }));
    expect(result.ok).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("a capability input literally named tenantId has no bearing on the session claim", async () => {
    const { pool, queries } = fakePool([]);
    await invokeSql(tool, { id: "1", tenantId: "attacker-supplied" }, baseOpts(pool));
    const setConfig = queries.find((q) => q.text === "SELECT set_config($1, $2, true)");
    expect(setConfig?.params).toEqual(["app.tenantId", "acme"]); // from identityAdapter, never from input
  });
});

describe("invokeSql — D-9 over-privileged connection detection", () => {
  it("refuses a superuser connection, naming rolsuper, before running the query", async () => {
    const { pool, queries } = fakePool([{ id: "1" }], { rolsuper: true, rolbypassrls: false });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolsuper/);
    expect(queries.some((q) => q.text === "BEGIN")).toBe(false);
  });

  it("refuses a BYPASSRLS role, naming rolbypassrls", async () => {
    const { pool } = fakePool([], { rolsuper: false, rolbypassrls: true });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolbypassrls/);
  });

  it("refuses a role that owns a relation it also holds a grant on, naming the exact schema.relation", async () => {
    const queries: Array<{ text: string }> = [];
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        queries.push({ text });
        if (text.includes("rolsuper")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes("role_table_grants")) return { rows: [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reporting\.portfolio_summary_v/);
  });

  it("does NOT refuse a role that owns a relation it holds no grant on (EC-8a)", async () => {
    const { pool } = fakePool([{ id: "1" }]); // default fakePool returns no owned-and-granted rows
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(true);
  });

  it("caches the over-privileged check across invocations on the same DSN (checked once, not per-call)", async () => {
    const { pool, client } = fakePool([{ id: "1" }]);
    const opts = baseOpts(pool);
    await invokeSql(tool, { id: "1" }, opts);
    await invokeSql(tool, { id: "1" }, opts);
    const roleCheckCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(([text]: [string]) => text.includes("rolsuper")).length;
    expect(roleCheckCalls).toBe(1);
  });
});

describe("invokeSql — response mapping surface (D-7)", () => {
  it("returns the driver's row array verbatim as data — undeclared columns are dropped later, by applyResponseMapping, not here", async () => {
    const { pool } = fakePool([{ id: "1", headline: "Q1", internal_notes: "secret" }]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.data).toEqual([{ id: "1", headline: "Q1", internal_notes: "secret" }]);
  });
});

describe("invokeSql — connection lifecycle (D-5, BR-24)", () => {
  it("a pool-checkout failure returns the same fail-closed shape invokeRest returns for a fetch failure", async () => {
    const pool: PgPool = { connect: vi.fn(async () => { throw new Error("pool exhausted"); }) };
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: false, status: 0, error: expect.stringContaining("pool checkout failed") });
  });

  it("a missing dsn env var fails closed with a missing-env-var message", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, { ...baseOpts(pool), env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing env var\(s\): DATABASE_URL/);
  });

  it("has no SQL connector -> a clean, consistent failure", async () => {
    const restTool: IRTool = { ...tool, connector: { type: "rest" } };
    const { pool } = fakePool([]);
    const result = await invokeSql(restTool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: false, status: 0, error: "capability 'reporting.portfolio-summary' has no SQL connector" });
  });
});
