import { describe, it, expect } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeRest, type FetchLike } from "../src/index";

// Isolated unit test — build the IR tools directly, no load/compile dependency.
const search: IRTool = {
  id: "tourism.search",
  description: "Find accommodation.",
  effect: "read",
  provider: "booking-api",
  policies: ["authenticated"],
  input: [],
  output: [],
  connector: {
    type: "rest",
    rest: { baseUrl: "${BOOKING_API_URL}", method: "POST", path: "/api/v1/hotels/search" },
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
