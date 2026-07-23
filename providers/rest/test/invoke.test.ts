import { describe, it, expect } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeRest, hostMatchesPattern, type FetchLike, type CallerContext } from "../src/index";

// Isolated unit test — build the IR tools directly, no load/compile dependency.
const search: IRTool = {
  id: "tourism.search",
  description: "Find accommodation.",
  effect: "read",
  provider: "booking-api",
  policies: [],
  input: [],
  output: [],
  connector: {
    type: "rest",
    rest: { baseUrl: "${BOOKING_API_URL}", method: "POST", path: "/api/v1/hotels/search" },
  },
};

// ADD-32 — a capability that DOES require a caller credential.
const authedSearch: IRTool = {
  ...search,
  policies: ["authenticated"],
  connector: {
    type: "rest",
    rest: {
      baseUrl: "${BOOKING_API_URL}",
      method: "POST",
      path: "/api/v1/hotels/search",
      headers: { Authorization: "Bearer ${caller.accessToken}" },
    },
  },
};

const unbound: IRTool = {
  id: "tourism.book",
  description: "Book.",
  effect: "write",
  provider: "booking-api",
  policies: [],
  input: [],
  output: [],
};

describe("invokeRest", () => {
  it("resolves ${env} baseUrl and POSTs the input as JSON", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
    expect(captured?.init.method).toBe("POST");
    expect(JSON.parse(String(captured?.init.body))).toEqual({ destination: "Nice" });
    expect(r.data).toEqual({ hotels: [{ id: "h1" }] });
  });

  it("interpolates {path} params from input", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const withParam: IRTool = {
      ...search,
      connector: { type: "rest", rest: { baseUrl: "${API}", method: "GET", path: "/hotels/{id}" } },
    };
    await invokeRest(withParam, { id: "abc 1" }, { env: { API: "https://x.test" }, fetchImpl });
    expect(captured?.url).toBe("https://x.test/hotels/abc%201");
  });

  it("errors when a required env var is missing", async () => {
    const fetchImpl: FetchLike = async () => new Response("");
    const r = await invokeRest(search, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing env var/);
  });

  it("errors when the capability has no REST connector", async () => {
    const fetchImpl: FetchLike = async () => new Response("");
    const r = await invokeRest(unbound, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no REST connector/);
  });

  it("surfaces a non-2xx backend status", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    const r = await invokeRest(
      search,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });
});

describe("invokeRest — ADD-32 caller credential propagation", () => {
  it("fails closed with no HTTP call attempted when an authenticated capability has no caller", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the gate must short-circuit before any request");
    };
    const r = await invokeRest(authedSearch, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/requires policies:\[authenticated\]/);
    expect(r.error).toContain("tourism.search");
  });

  it("fires the gate before env resolution — a missing env var never masks the missing-caller message", async () => {
    // BOOKING_API_URL deliberately unset too — the caller-gate message must win.
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const r = await invokeRest(authedSearch, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires policies:\[authenticated\]/);
    expect(r.error).not.toMatch(/missing env var/);
  });

  it("attaches ${caller.accessToken} to the outbound request when supplied", async () => {
    let captured: { headers: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response("{}", { status: 200 });
    };
    const caller: CallerContext = { accessToken: "user-token-123" };
    const r = await invokeRest(
      authedSearch,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, caller },
    );
    expect(r.ok).toBe(true);
    expect(captured?.headers.Authorization).toBe("Bearer user-token-123");
  });

  it("treats an empty-string accessToken as present — the gate passes, the call proceeds", async () => {
    let captured: { headers: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      authedSearch,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, caller: { accessToken: "" } },
    );
    expect(r.ok).toBe(true);
    expect(captured?.headers.Authorization).toBe("Bearer ");
  });

  it("reports a missing ${caller.NAME} template key distinctly from a missing env var", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    // Not `authenticated`, so the gate doesn't fire — but the binding still references a
    // caller placeholder that's never supplied. Distinct message from "missing env var(s)".
    const tool: IRTool = {
      ...search,
      connector: {
        type: "rest",
        rest: {
          baseUrl: "${BOOKING_API_URL}",
          method: "GET",
          path: "/hotels",
          headers: { "X-User": "${caller.accessToken}" },
        },
      },
    };
    const r = await invokeRest(tool, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing caller credential(s): accessToken");
  });

  it("a service-account-only capability (no authenticated policy, no ${caller.…} template) is byte-for-byte unaffected", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
    expect(r.data).toEqual({ hotels: [{ id: "h1" }] });
  });
});

// Security hardening (follow-up to ADD-32): baseUrl is the one placeholder destination where a
// caller-controlled value can redirect the ENTIRE outbound request, not just its content — so a
// binding whose baseUrl contains ${caller.NAME} must have its resolved host checked against a
// deployer-configured InvokeOptions.allowedHosts, failing closed by default. No shipped binding
// uses ${caller.…} in baseUrl today (hence the tool fixture below is synthetic, not a real
// manifest) — this is proactive hardening of the mechanism, not a fix for a live exploit.
describe("invokeRest — caller-influenced baseUrl allowlist (security hardening)", () => {
  // Per-tenant routing: the whole host is caller-controlled via ${caller.tenantId}.
  const tenantRouted: IRTool = {
    ...search,
    id: "tenant.accounts",
    connector: {
      type: "rest",
      rest: { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/accounts" },
    },
  };

  it("regression: a ${VAR}-only baseUrl with no allowedHosts configured behaves exactly as before", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl }, // no allowedHosts at all
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
  });

  it("proceeds when the resolved host is an exact match in allowedHosts", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-a.core.example.com" },
        allowedHosts: ["tenant-a.core.example.com"],
      },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://tenant-a.core.example.com/accounts");
  });

  it("proceeds when the resolved host matches a *.suffix wildcard entry", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-a.core.example.com" },
        allowedHosts: ["*.core.example.com"],
      },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://tenant-a.core.example.com/accounts");
  });

  it("a *.suffix wildcard must NOT match a host missing the dot separator (no false-positive prefix match)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — 'evilcore.example.com' is not a subdomain of core.example.com");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "evilcore.example.com" },
        allowedHosts: ["*.core.example.com"],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
    expect(r.error).toContain("evilcore.example.com");
  });

  it("fails closed, with no network attempt, when the resolved host is not in the allowlist at all", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the allowlist gate must short-circuit before any request");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-b.core.example.com" },
        allowedHosts: ["tenant-a.core.example.com"],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("fails closed by default when allowedHosts is entirely omitted — not a silent bypass", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — an undefined allowlist must not be treated as allow-all");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      { env: {}, fetchImpl, caller: { tenantId: "tenant-a.core.example.com" } }, // no allowedHosts
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("fails closed with a distinct error when the resolved baseUrl is not a valid URL", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    // caller.tenantId resolves to "" (empty, but present per ADD-32 §3/R-6) — baseUrl becomes
    // the bare string "https://", which `new URL()` rejects (no host).
    const r = await invokeRest(
      tenantRouted,
      {},
      { env: {}, fetchImpl, caller: { tenantId: "" }, allowedHosts: ["anything.example.com"] },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/baseUrl is not a valid URL after caller-placeholder substitution/);
    expect(r.error).not.toMatch(/allowlist/);
  });
});

describe("hostMatchesPattern", () => {
  it("exact match", () => {
    expect(hostMatchesPattern("api.example.com", "api.example.com")).toBe(true);
    expect(hostMatchesPattern("api.example.com", "other.example.com")).toBe(false);
  });

  it("wildcard matches any subdomain but not the bare suffix itself unless listed separately", () => {
    expect(hostMatchesPattern("tenant-a.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false);
  });

  it("wildcard does not false-positive-match a host that merely ends with the suffix text (no dot boundary)", () => {
    expect(hostMatchesPattern("evilexample.com", "*.example.com")).toBe(false);
  });

  it("case-insensitive on both host and pattern", () => {
    expect(hostMatchesPattern("API.Example.COM", "api.example.com")).toBe(true);
    expect(hostMatchesPattern("Tenant-A.Example.com", "*.EXAMPLE.com")).toBe(true);
  });
});
