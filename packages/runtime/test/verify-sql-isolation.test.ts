import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRResourceRegistry, IRTool } from "@archstone/compiler";
import { fingerprintShape } from "@archstone/compiler";
import type { PgPool, PgPoolClient, ConnectionEntry } from "@archstone/provider-sql";
import { verifyTool } from "../src/verify";

// ADR-0012 D-8 — the mandatory negative isolation test in `archstone verify`.

const resources: IRResourceRegistry = {};

function sqlTool(): IRTool {
  return {
    id: "reporting.portfolio-summary",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [{ name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } }],
    output: [],
    connector: {
      type: "sql",
      sql: {
        engine: "postgres",
        dsn: "${DATABASE_URL}",
        statementKind: "select",
        query: "SELECT id FROM reporting.portfolio_summary_v WHERE tenant_id = current_setting('app.tenantId') AND id = $1",
        params: ["id"],
      },
    },
    contract: { fingerprint: fingerprintShape([{ id: "1" }]), probeFixture: "fixture.json" },
  };
}

function withFixture(fixture: Record<string, unknown>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "archstone-verify-sql-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Fake pool: returns `positiveRows` for the acme tenant, `negativeRows` for anything else. */
function fakePool(positiveRows: Array<Record<string, unknown>>, negativeRows: Array<Record<string, unknown>>): PgPool {
  const client: PgPoolClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes("rolsuper")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
      if (text.includes("role_table_grants")) return { rows: [] };
      void params;
      if (text === "SELECT set_config($1, $2, true)") {
        return { rows: [] };
      }
      if (text.includes("FROM reporting.portfolio_summary_v")) {
        // Distinguish positive/negative by the LAST set_config call observed via closure below.
        return { rows: lastClaim === "acme" ? positiveRows : negativeRows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  let lastClaim: string | undefined;
  const originalQuery = client.query;
  client.query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text === "SELECT set_config($1, $2, true)" && params) lastClaim = params[1] as string;
    return originalQuery(text, params);
  });
  return { connect: vi.fn(async () => client) };
}

function opts(pool: PgPool, resolvable: Set<string> = new Set(["tenant-a", "tenant-b"])) {
  return {
    env: { DATABASE_URL: "postgres://runtime@localhost/app" },
    pgPoolFactory: () => pool,
    connectionRegistry: new Map<string, ConnectionEntry>(),
    caller: { principal: "tenant-a" },
    identityAdapter: (principal: string | undefined) => {
      if (principal === "tenant-a" && resolvable.has("tenant-a")) return { tenantId: "acme" };
      if (principal === "tenant-b" && resolvable.has("tenant-b")) return { tenantId: "beta" };
      return undefined;
    },
  };
}

describe("verifyTool — ADR-0012 D-8 negative isolation test", () => {
  it("S-US5.1: a recorded negativeIdentity whose replay returns zero rows passes", () =>
    withFixture(
      { capabilityId: "reporting.portfolio-summary", request: { id: "1" }, negativeIdentity: { principal: "tenant-b" } },
      async (dir) => {
        const pool = fakePool([{ id: "1" }], []);
        const r = await verifyTool(sqlTool(), dir, resources, opts(pool));
        expect(r.status).not.toBe("red");
      },
    ));

  it("S-US5.2: a recorded negativeIdentity whose replay returns rows is a hard red, naming the row count", () =>
    withFixture(
      { capabilityId: "reporting.portfolio-summary", request: { id: "1" }, negativeIdentity: { principal: "tenant-b" } },
      async (dir) => {
        const pool = fakePool([{ id: "1" }], [{ id: "1" }, { id: "2" }]);
        const r = await verifyTool(sqlTool(), dir, resources, opts(pool));
        expect(r.status).toBe("red");
        expect(r.detail).toBe("isolation test failed: 2 foreign rows returned for capability 'reporting.portfolio-summary'");
      },
    ));

  it("S-US5.3: a contract-bearing sql binding with no recorded negativeIdentity is red", () =>
    withFixture({ capabilityId: "reporting.portfolio-summary", request: { id: "1" } }, async (dir) => {
      const pool = fakePool([{ id: "1" }], []);
      const r = await verifyTool(sqlTool(), dir, resources, opts(pool));
      expect(r.status).toBe("red");
      expect(r.detail).toBe("isolation not verified: no negative identity recorded");
    }));

  it("S-US5.5: a recorded but unresolvable negativeIdentity fails identically to absent, with a distinct detail", () =>
    withFixture(
      { capabilityId: "reporting.portfolio-summary", request: { id: "1" }, negativeIdentity: { principal: "ghost-tenant" } },
      async (dir) => {
        const pool = fakePool([{ id: "1" }], []);
        const r = await verifyTool(sqlTool(), dir, resources, opts(pool, new Set(["tenant-a"])));
        expect(r.status).toBe("red");
        expect(r.detail).toBe("isolation not verified: negative identity did not resolve to any claims");
      },
    ));

  it("S-US5.4: the negative isolation test does not run for rest bindings (regression)", () =>
    withFixture({ capabilityId: "tourism.search", request: {} }, async (dir) => {
      const restTool: IRTool = {
        id: "tourism.search",
        description: "",
        effect: "read",
        provider: "",
        policies: [],
        lifecycle: "stable",
        input: [],
        output: [],
        connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "GET", path: "/search" } },
        contract: { fingerprint: fingerprintShape({}), probeFixture: "fixture.json" },
      };
      const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
      const r = await verifyTool(restTool, dir, resources, { fetchImpl });
      expect(r.status).not.toBe("red");
    }));
});
