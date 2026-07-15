import { describe, it, expect } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeRest, type FetchLike, type InvokeResult } from "../src/index";

// Isolated unit tests for #15 — REST request building. Build IR literals directly
// and inject fetchImpl so we can assert on the exact request the provider produces.

const base: Omit<IRTool, "connector"> = {
  id: "tourism.search",
  description: "Find accommodation.",
  effect: "read",
  provider: "hotels-api",
  policies: [],
  input: [],
  output: [],
};

function restTool(rest: NonNullable<IRTool["connector"]>["rest"]): IRTool {
  return { ...base, connector: { type: "rest", rest } };
}

// A fetch stub that records the single request it receives.
function capturingFetch(): { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: FetchLike } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

const ENV = { HOTELS: "https://api.hotels.example" };

describe("#15 GET/HEAD query serialization (US-2)", () => {
  it("S-US2.1: GET serializes non-path input into the query string, no body", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels" });
    await invokeRest(tool, { city: "paris", guests: 2 }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.hotels.example/hotels?city=paris&guests=2");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("S-US2.2 / EC-6: path-consumed fields are excluded from the query string", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}/rooms" });
    await invokeRest(tool, { city: "paris", guests: 2 }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.hotels.example/hotels/paris/rooms?guests=2");
    expect(calls[0].url).not.toContain("city=");
  });

  it("S-US2.3: HEAD serializes non-path input into the query and sends no body", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "HEAD", path: "/hotels" });
    await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(calls[0].init.method).toBe("HEAD");
    expect(calls[0].url).toContain("city=paris");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("S-US2.4 / BR-3: GET with only path fields produces no query string", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}" });
    await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.hotels.example/hotels/paris");
    expect(calls[0].url).not.toContain("?");
  });

  it("EC-1/EC-2: object and array fields are JSON-encoded into the query", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels" });
    await invokeRest(tool, { filter: { min: 1 }, tags: ["a", "b"] }, { env: ENV, fetchImpl });
    const qs = new URL(calls[0].url).searchParams;
    expect(qs.get("filter")).toBe(JSON.stringify({ min: 1 }));
    expect(qs.get("tags")).toBe(JSON.stringify(["a", "b"]));
  });

  it("EC-3: null/undefined fields are omitted from the query", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels" });
    await invokeRest(tool, { city: "paris", note: null, extra: undefined }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.hotels.example/hotels?city=paris");
  });
});

describe("#15 missing required path parameter (US-3)", () => {
  const encoded = (r: InvokeResult) => r; // readability helper

  it("S-US3.1: missing path param fails before any request, naming param + capability", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}/rooms" });
    const r = encoded(await invokeRest(tool, { guests: 2 }, { env: ENV, fetchImpl }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("city");
    expect(r.error).toContain("tourism.search");
    expect(calls).toHaveLength(0);
  });

  it("S-US3.2: empty-string path param fails before any request", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}/rooms" });
    const r = await invokeRest(tool, { city: "", guests: 2 }, { env: ENV, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("city");
    expect(calls).toHaveLength(0);
  });

  it("S-US3.3: never sends the malformed /hotels/ URL", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}" });
    const r = await invokeRest(tool, {}, { env: ENV, fetchImpl });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("S-US3.4 / BR-10: a provided path param is interpolated and URL-encoded", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{city}" });
    await invokeRest(tool, { city: "são paulo" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.hotels.example/hotels/s%C3%A3o%20paulo");
  });
});

describe("#15 body template honour vs default (US-4)", () => {
  it("S-US4.1 / S-US4.3: authored body template is honoured; extra input not sent verbatim", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "POST",
      path: "/search",
      body: '{"city":"{city}"}',
    });
    await invokeRest(tool, { city: "paris", internalTraceId: "x", secret: "leak" }, { env: ENV, fetchImpl });
    const body = String(calls[0].init.body);
    expect(JSON.parse(body)).toEqual({ city: "paris" });
    expect(body).not.toContain("internalTraceId");
    expect(body).not.toContain("secret");
  });

  it("S-US4.2 / EC-9: absent body template falls back to the default JSON body", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "POST", path: "/search" });
    await invokeRest(tool, { city: "paris", guests: 2 }, { env: ENV, fetchImpl });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ city: "paris", guests: 2 });
  });

  it("S-US4.4 / EC-8: a body template on GET/HEAD sends no body, query still built", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "GET",
      path: "/search",
      body: '{"city":"{city}"}',
    });
    await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].url).toContain("city=paris");
  });
});

describe("#15 empty vs unset env (US-5)", () => {
  it("S-US5.1: an empty-string env value resolves and the call proceeds", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "POST",
      path: "/search",
      headers: { "X-Api-Version": "${API_VERSION}" },
    });
    const r = await invokeRest(tool, {}, { env: { ...ENV, API_VERSION: "" }, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>)["X-Api-Version"]).toBe("");
  });

  it("S-US5.2: an unset env var fails with a missing-env error", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "POST",
      path: "/search",
      headers: { Authorization: "Bearer ${API_KEY}" },
    });
    const r = await invokeRest(tool, {}, { env: ENV, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing env var(s): API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("S-US5.3: an empty baseUrl env value does not block the call as missing", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${BASE}/v1", method: "POST", path: "/search" });
    const r = await invokeRest(tool, {}, { env: { BASE: "" }, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/v1/search");
  });

  it("S-US5.4: unset and empty env vars are reported distinctly in the same call", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "POST",
      path: "/search",
      headers: { Authorization: "Bearer ${API_KEY}" },
    });
    const r = await invokeRest(tool, {}, { env: { HOTELS: "https://api.hotels.example", BASE: "" }, fetchImpl });
    expect(r.error).toContain("API_KEY");
    expect(r.error).not.toContain("BASE");
    expect(calls).toHaveLength(0);
  });

  it("EC-10: a whitespace-only env value is treated as a set value", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "POST",
      path: "/search",
      headers: { "X-Api-Version": "${API_VERSION}" },
    });
    const r = await invokeRest(tool, {}, { env: { ...ENV, API_VERSION: " " }, fetchImpl });
    expect(r.error).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)["X-Api-Version"]).toBe(" ");
  });
});

describe("#16 NF-1: body-template env resolved only when a body is sent", () => {
  it("a GET whose unused body template references an unset ${VAR} still succeeds", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({
      baseUrl: "${HOTELS}",
      method: "GET",
      path: "/search",
      body: '{"k":"${SECRET}"}', // SECRET is unset — but no body is ever sent on GET
    });
    const r = await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].url).toContain("city=paris");
  });

  it("a HEAD whose unused body template references an unset ${VAR} still succeeds", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "HEAD", path: "/search", body: '{"k":"${SECRET}"}' });
    const r = await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].init.body).toBeUndefined();
  });

  it("a non-GET/HEAD with the same unset ${VAR} in its body still fails as missing-env", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "POST", path: "/search", body: '{"k":"${SECRET}"}' });
    const r = await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing env var(s): SECRET");
    expect(calls).toHaveLength(0);
  });
});

describe("#16 NF-2 (characterization): non-identifier path placeholders pass through literally", () => {
  // PLACEHOLDER_RE is identifier-only (`{[A-Za-z_][A-Za-z0-9_]*}`) so a JSON body
  // template's own braces are not mistaken for placeholders. A side effect is that
  // hyphenated/dotted path placeholders are NOT matched: they are neither
  // interpolated nor reported missing, so the literal token is sent in the URL.
  // This is LATENT — no real manifest uses such a placeholder, and CDL input field
  // names are identifiers. Documented here to pin the behaviour if it ever changes.
  it("a hyphenated {hotel-id} placeholder is left literal in the URL, not reported missing", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/hotels/{hotel-id}" });
    const r = await invokeRest(tool, { "hotel-id": "h1" }, { env: ENV, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    // literal `{hotel-id}` survives verbatim in the path; the value goes to the query instead.
    expect(calls[0].url).toBe("https://api.hotels.example/hotels/{hotel-id}?hotel-id=h1");
  });

  it("a dotted {user.id} placeholder is likewise passed through literally", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${HOTELS}", method: "GET", path: "/u/{user.id}" });
    const r = await invokeRest(tool, { "user.id": "u1" }, { env: ENV, fetchImpl });
    expect(r.error).toBeUndefined();
    expect(calls[0].url).toBe("https://api.hotels.example/u/{user.id}?user.id=u1");
  });
});
