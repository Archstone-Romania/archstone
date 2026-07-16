import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { mockStaysResponse } from "../src/mock-backend";

const ORIGIN = "http://demo.local";

function mcpRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

describe("mock-backend", () => {
  it("echoes the destination into a typed Stay shape", async () => {
    const req = new Request(`${ORIGIN}/v1/search`, {
      method: "POST",
      body: JSON.stringify({ destination: "Lisbon" }),
    });
    const res = await mockStaysResponse(req);
    const json = (await res.json()) as { stays: { name: string; location: string; pricePerNight: number }[] };
    expect(json.stays).toHaveLength(3);
    expect(json.stays[0].location).toBe("Lisbon");
    expect(json.stays[0].name).toContain("Lisbon");
    expect(typeof json.stays[0].pricePerNight).toBe("number");
  });

  it("is deterministic per destination", async () => {
    const req = () =>
      new Request(`${ORIGIN}/v1/search`, { method: "POST", body: JSON.stringify({ destination: "Nice" }) });
    const first = await (await mockStaysResponse(req())).json();
    const second = await (await mockStaysResponse(req())).json();
    expect(first).toEqual(second);
  });
});

describe("worker /mcp", () => {
  it("initializes and lists tourism_search with a typed outputSchema", async () => {
    const init = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        },
      }),
    );
    expect(init.status).toBe(200);

    const list = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result?: { tools: { name: string }[] } };
    const names = listBody.result?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("tourism_search");
  });

  it("404s outside /mcp and /v1/search", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/nope`));
    expect(res.status).toBe(404);
  });
});
