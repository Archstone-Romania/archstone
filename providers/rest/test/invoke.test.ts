import { describe, it, expect } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeRest, type FetchLike, type CallerContext } from "../src/index";

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
