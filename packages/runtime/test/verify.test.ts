import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRResourceRegistry, IRTool } from "@archstone/compiler";
import { fingerprintShape } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";
import { verifyTool, runVerify } from "../src/verify";

const resources: IRResourceRegistry = {
  Stay: [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
    { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
    { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
  ],
};

const goldenBody = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5 }] };
const goldenFingerprint = fingerprintShape(goldenBody);

function tool(contractFingerprint: string, fixtureName = "fixture.json"): IRTool {
  return {
    id: "tourism.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    input: [],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }],
    connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/search" } },
    response: {
      resource: "Stay",
      field: "stays",
      collection: "$.stays[*]",
      fields: [
        { name: "name", path: "$.name" },
        { name: "location", path: "$.location" },
        { name: "price", path: "$.price" },
        { name: "rating", path: "$.rating" },
      ],
    },
    contract: { fingerprint: contractFingerprint, probeFixture: fixtureName },
  };
}

function withFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "archstone-verify-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "tourism.search", request: {}, expects: { collectionNonEmpty: true } }));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("verifyTool (ADD-18)", () => {
  it("green: fingerprint unchanged, mapping OK", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("green");
    }));

  it("yellow: fingerprint changed (new field added) but required fields still resolve", () =>
    withFixture(async (dir) => {
      const drifted = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, currency: "EUR" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(drifted), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("yellow");
      expect(r.detail).toMatch(/shape changed/);
    }));

  it("yellow: optional field absent → DEGRADED", () =>
    withFixture(async (dir) => {
      const noRating = { stays: [{ name: "Hotel A", location: "Nice", price: 100 }] };
      const fp = fingerprintShape(noRating);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noRating), { status: 200 });
      const r = await verifyTool(tool(fp), dir, resources, { fetchImpl });
      expect(r.status).toBe("yellow");
      expect(r.detail).toMatch(/degraded/);
    }));

  it("red: required field missing → VIOLATION", () =>
    withFixture(async (dir) => {
      const noPrice = { stays: [{ name: "Hotel A", location: "Nice" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noPrice), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/price/);
    }));

  it("red: collectionNonEmpty expected but the collection is empty", () =>
    withFixture(async (dir) => {
      const empty = { stays: [] };
      const fp = fingerprintShape(empty);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(empty), { status: 200 });
      const r = await verifyTool(tool(fp), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/non-empty/);
    }));

  it("red: live request fails", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response("boom", { status: 500 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/live request failed/);
    }));

  it("red: fixture file missing", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint, "does-not-exist.json"), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/fixture not found/);
    }));

  it("red: no contract declared", () =>
    withFixture(async (dir) => {
      const t = tool(goldenFingerprint);
      delete t.contract;
      const r = await verifyTool(t, dir, resources);
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/no contract/);
    }));
});

describe("runVerify — filters to contract-bearing tools", () => {
  it("only verifies tools that declare a contract", () =>
    withFixture(async (dir) => {
      const withContract = tool(goldenFingerprint);
      const withoutContract: IRTool = { ...tool(goldenFingerprint), id: "tourism.other", contract: undefined };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const reports = await runVerify([withContract, withoutContract], dir, resources, { fetchImpl });
      expect(reports).toHaveLength(1);
      expect(reports[0].capabilityId).toBe("tourism.search");
    }));
});
