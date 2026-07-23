import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR, InvalidArtifactError } from "../src/index";

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

// ADD-32: execute() forwards `caller` to invokeRest as a pure pass-through — no policy
// logic lives here. tourism.search itself carries no `authenticated` policy (#32 removed
// it as a mislabeled demo policy — see tourism.search.capability.yaml), so this uses a
// synthetic authenticated tool built from the same registry's connector shape instead of
// depending on manifest content that may change independently of this test's intent.
describe("execute() — caller credential propagation (ADD-32)", () => {
  it("reaches the backend with the caller's token attached via a ${caller.…} binding placeholder", async () => {
    let capturedAuth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    };
    // Simulate an authenticated binding by mutating the loaded IR's tool connector headers
    // in place — this only exercises invokeRest's ${caller.…} resolution, not policy gating
    // (covered by the dedicated policies test below).
    const artifact = loadArtifact() as { tools: { id: string; connector?: { rest?: { headers?: Record<string, string> } } }[] };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    tool.connector!.rest!.headers = { Authorization: "Bearer ${caller.accessToken}" };
    const withHeader = fromIR(artifact);

    const r = await withHeader.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, caller: { accessToken: "user-token-abc" } },
    );
    expect(r.status).toBe("ok");
    expect(capturedAuth).toBe("Bearer user-token-abc");
  });

  it("an authenticated capability with no caller supplied fails closed with status: 'error'", async () => {
    const artifact = loadArtifact() as { tools: { id: string; policies: string[] }[] };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    tool.policies = ["authenticated"];
    const archstone = fromIR(artifact);

    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the gate must short-circuit first");
    };
    const r = await archstone.execute("tourism.search", { destination: "Nice" }, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/requires policies:\[authenticated\]/);
  });

  it("allowedHosts reaches invokeRest — proceeds when the caller-influenced baseUrl host matches the allowlist", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    // Synthetic per-tenant-routed connector — no shipped binding does this today (see
    // providers/rest security-hardening comment); mutate the loaded IR the same way the
    // caller-propagation test above does, to isolate execute()'s pass-through of allowedHosts.
    const artifact = loadArtifact() as {
      tools: { id: string; response?: unknown; connector?: { rest?: Record<string, unknown> } }[];
    };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    delete tool.response; // raw pass-through — isolate the allowlist gate, not response mapping
    tool.connector!.rest = { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/stays" };
    const archstone = fromIR(artifact);

    const r = await archstone.execute(
      "tourism.search",
      {},
      { fetchImpl, caller: { tenantId: "tenant-a.core.example.com" }, allowedHosts: ["*.core.example.com"] },
    );
    expect(r.status).toBe("ok");
    expect(captured?.url).toBe("https://tenant-a.core.example.com/stays");
  });

  it("allowedHosts reaches invokeRest — fails closed when the caller-influenced baseUrl host is not allowlisted", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the allowlist gate must short-circuit first");
    };
    const artifact = loadArtifact() as {
      tools: { id: string; response?: unknown; connector?: { rest?: Record<string, unknown> } }[];
    };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    delete tool.response;
    tool.connector!.rest = { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/stays" };
    const archstone = fromIR(artifact);

    const r = await archstone.execute(
      "tourism.search",
      {},
      { fetchImpl, caller: { tenantId: "evilcore.example.com" }, allowedHosts: ["*.core.example.com"] },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("omitting caller behaves exactly as before for a non-authenticated capability", async () => {
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
  });
});

// ADD-30 (#30): tools(format) advertises "tourism_search" (toolName("tourism.search")) —
// execute() must resolve that exact advertised string back to "tourism.search", identically
// across every ToolFormat (BR-1/BR-7), since all four share the one toolName() lowering.
describe("round trip — tools(format)'s advertised name resolves in execute() (BR-1/BR-7)", () => {
  const formats = ["anthropic", "openai", "gemini", "json-schema"] as const;

  it.each(formats)("%s: the advertised name invokes the same capability as its raw id", async (format) => {
    const archstone = fromIR(loadArtifact());
    const advertised = archstone.tools(format)[0] as { name?: string; function?: { name: string } };
    const name = advertised.name ?? advertised.function?.name;
    expect(name).toBe("tourism_search"); // toolName("tourism.search")

    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const r = await archstone.execute(
      name!,
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] });
  });

  it("S-US1.5: the round trip preserves a degraded outcome, identical to the raw-id call", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] }), {
        status: 200,
      });
    const viaSanitized = await archstone.execute(
      "tourism_search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    const viaRawId = await archstone.execute(
      "tourism.search",
      { destination: "Nice" },
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(viaSanitized.status).toBe("degraded");
    expect(viaSanitized).toEqual(viaRawId);
  });
});

describe("US-3 — unresolved name never crashes or misroutes (EC-2/EC-6/EC-7)", () => {
  it("EC-2/S-US3.3: an empty string never resolves to any capability", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — empty string must not resolve");
    };
    const r = await archstone.execute("", {}, { fetchImpl });
    expect(r.status).toBe("error");
  });

  it("S-US3.2: a near-miss (typo'd) name is never treated as a match, no outbound request is made", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — a misspelled name must not resolve");
    };
    const r = await archstone.execute("tourism_serach", {}, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/tourism_serach/);
  });

  it("EC-6: case differs from the advertised name — treated as unresolved, no case-insensitive fallback", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — case must not be folded");
    };
    const r = await archstone.execute("Tourism_Search", {}, { fetchImpl });
    expect(r.status).toBe("error");
  });

  it("EC-7: a raw string with characters toolName() would itself sanitize is never re-sanitized to force a match", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — execute() must not re-sanitize its input");
    };
    const r = await archstone.execute("tourism search", {}, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/tourism search/);
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

// ADD-30 (#30) D-2: fromIR refuses an artifact with a tool-name collision before tools()/
// execute() are ever reachable — the primary, practical boundary this fix protects, since
// an externally-produced IR artifact (unlike a real CDL-authored manifest, whose
// `capability.id` pattern can never itself produce a toolName() collision) is not
// re-validated against cdl.schema.json.
describe("fromIR — refuses an artifact with a tool-name collision (ADD-30 D-2)", () => {
  const collidingIr = {
    version: "0",
    company: { id: "acme" },
    resources: {},
    tools: [
      {
        id: "a.b",
        description: "d",
        effect: "read",
        provider: "p",
        policies: [],
        input: [],
        output: [],
        connector: { type: "rest", rest: { method: "GET", path: "/a" } },
      },
      {
        id: "a_b",
        description: "d",
        effect: "read",
        provider: "p",
        policies: [],
        input: [],
        output: [],
        connector: { type: "rest", rest: { method: "GET", path: "/b" } },
      },
    ],
  };

  it("throws InvalidArtifactError naming both colliding ids", () => {
    let caught: unknown;
    try {
      fromIR(collidingIr);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidArtifactError);
    expect((caught as Error).message).toMatch(/a\.b/);
    expect((caught as Error).message).toMatch(/a_b/);
  });

  it("tools()/execute() are never reached — the throw happens inside fromIR itself", () => {
    expect(() => fromIR(collidingIr)).toThrow(InvalidArtifactError);
  });
});
