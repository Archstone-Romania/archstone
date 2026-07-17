import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly. */
function loadArtifact(): unknown {
  const ir = buildRegistry(tourism).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

// tourism.search's binding: POST ${STAYS_API_URL}/v1/search, response mapped to Stay
// (name/location/pricePerNight required, rating optional) — see
// examples/manifests/tourism/bindings/tourism.search.binding.yaml.

describe("execute() — 4-state result (ADD-0008 #28, R-8)", () => {
  it("ok: full mapped response", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const r = await archstone.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] });
    expect(r.missing).toBeUndefined();
    expect(r.degraded).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("degraded: optional field (rating) absent — mapped data still returned", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] }), {
        status: 200,
      });
    const r = await archstone.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["rating"]);
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] });
  });

  it("violation: required field (pricePerNight) absent — no raw data leaks through", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }] }), { status: 200 });
    const r = await archstone.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["pricePerNight"]);
    expect(r.data).toBeUndefined();
  });

  it("error: missing env var — invokeRest short-circuits before any request (R-8, not a violation)", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — missing env must short-circuit first");
    };
    // env deliberately omitted: STAYS_API_URL is never resolvable.
    const r = await archstone.execute("tourism.search", { destination: "Nice" }, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/STAYS_API_URL/);
    expect(r.data).toBeUndefined();
    expect(r.missing).toBeUndefined();
  });

  it("error: network failure — invokeRest's ok:false surfaces verbatim as .error", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const r = await archstone.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/request failed/i);
  });

  it("error: unknown capability id", async () => {
    const archstone = fromIR(loadArtifact());
    const r = await archstone.execute("does.not-exist", {});
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/unknown capability/i);
  });

  it("never falls back to process.env when opts.env is omitted (Workers-safety, ADD-0008 §7.2)", async () => {
    process.env.STAYS_API_URL = "https://should-not-be-used.test";
    try {
      const archstone = fromIR(loadArtifact());
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called — process.env must never be consulted");
      };
      const r = await archstone.execute("tourism.search", { destination: "Nice" }, { fetchImpl });
      expect(r.status).toBe("error");
      expect(r.error).toMatch(/STAYS_API_URL/);
    } finally {
      delete process.env.STAYS_API_URL;
    }
  });
});

describe("fromIR — fail-closed version check", () => {
  it("throws on a missing version", () => {
    expect(() => fromIR({ tools: [], resources: {}, company: { id: "x" } })).toThrow(/version/);
  });

  it("throws on a wrong version", () => {
    expect(() => fromIR({ version: "1", tools: [], resources: {}, company: { id: "x" } })).toThrow(/version/);
  });

  it("throws on a non-object", () => {
    expect(() => fromIR(null)).toThrow();
    expect(() => fromIR("archstone.ir.json")).toThrow();
  });

  it("accepts a valid version:'0' artifact", () => {
    const archstone = fromIR(loadArtifact());
    expect(archstone.registry.size).toBeGreaterThan(0);
  });
});
