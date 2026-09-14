import { describe, it, expect } from "vitest";
import type { IRField, IRTool } from "@archstone/compiler";
import { invokeRest, type FetchLike } from "../src/index";

// Issue #63 — explode-aware list serialization (Goal 1/US-2), query-alongside-body field
// partitioning (Goal 2/US-3), and the founder's required-empty-list ruling.

const base: Omit<IRTool, "connector" | "input"> = {
  id: "acme.things",
  description: "d",
  effect: "read",
  provider: "acme-api",
  policies: [],
  output: [],
};

function restTool(rest: NonNullable<IRTool["connector"]>["rest"], input: IRField[]): IRTool {
  return { ...base, input, connector: { type: "rest", rest } };
}

function capturingFetch(): { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: FetchLike } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

const ENV = { API: "https://api.acme.example" };

describe("#63 Goal 1 — list-field query serialization", () => {
  const tags: IRField = { name: "tags", required: false, type: { kind: "list", items: "string" } };

  it("S-US2.3: explode: true (default) repeats the key", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${API}", method: "GET", path: "/things" }, [tags]);
    await invokeRest(tool, { tags: ["a", "b"] }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?tags=a&tags=b");
  });

  it("S-US2.4: explode: false comma-joins", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${API}", method: "GET", path: "/things", query: { tags: { explode: false } } }, [tags]);
    await invokeRest(tool, { tags: ["a", "b"] }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?tags=a%2Cb");
  });

  it("respects a `name` remap alongside `explode`", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${API}", method: "GET", path: "/things", query: { tags: { name: "tag", explode: true } } }, [tags]);
    await invokeRest(tool, { tags: ["a", "b"] }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?tag=a&tag=b");
  });

  it("founder ruling: a required list value of [] omits the query param entirely, and the call is NOT rejected", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const required: IRField = { name: "tags", required: true, type: { kind: "list", items: "string" } };
    const tool = restTool({ baseUrl: "${API}", method: "GET", path: "/things" }, [required]);
    const result = await invokeRest(tool, { tags: [] }, { env: ENV, fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.acme.example/things");
  });

  it("a scalar (non-list) field is unaffected by the list machinery", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const city: IRField = { name: "city", required: false, type: { kind: "scalar", semantic: "string" } };
    const tool = restTool({ baseUrl: "${API}", method: "GET", path: "/things" }, [city]);
    await invokeRest(tool, { city: "paris" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?city=paris");
  });
});

describe("#63 Goal 2 — query field alongside a JSON body", () => {
  const dryRun: IRField = { name: "dryRun", required: false, type: { kind: "scalar", semantic: "string" } };
  const payload: IRField = { name: "payload", required: false, type: { kind: "scalar", semantic: "string" } };

  it("S-US3.3: an `onQuery`-marked field goes on the URL; every other field goes in the JSON body, in the same call", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool(
      { baseUrl: "${API}", method: "POST", path: "/things", query: { dryRun: { onQuery: true } } },
      [dryRun, payload],
    );
    await invokeRest(tool, { dryRun: "true", payload: "x" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?dryRun=true");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ payload: "x" });
  });

  it("no `onQuery` marker: unchanged pre-#63 behaviour — no query string at all when a body is sent", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tool = restTool({ baseUrl: "${API}", method: "POST", path: "/things" }, [dryRun, payload]);
    await invokeRest(tool, { dryRun: "true", payload: "x" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ dryRun: "true", payload: "x" });
  });

  it("an `onQuery` list field explodes onto the URL and is excluded from the body", async () => {
    const { calls, fetchImpl } = capturingFetch();
    const tags: IRField = { name: "tags", required: false, type: { kind: "list", items: "string" } };
    const tool = restTool(
      { baseUrl: "${API}", method: "POST", path: "/things", query: { tags: { onQuery: true } } },
      [tags, payload],
    );
    await invokeRest(tool, { tags: ["a", "b"], payload: "x" }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/things?tags=a&tags=b");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ payload: "x" });
  });
});
