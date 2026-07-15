import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../src/registry";
import { toolDefinitions, callTool, toolName, inputJsonSchema } from "../src/mcp";
import type { IRField } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const registry = buildRegistry(booking).registry!;

describe("toolName", () => {
  it("sanitizes capability ids to MCP tool names", () => {
    expect(toolName("tourism.search")).toBe("tourism_search");
  });
});

describe("toolDefinitions — IR → MCP tools", () => {
  const defs = toolDefinitions(registry);

  it("emits only bound capabilities as tools", () => {
    // booking has 4 capabilities but only tourism.search is bound
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("tourism_search");
  });

  it("lowers semantic input to JSON Schema", () => {
    const schema = defs[0].inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["destination", "dates", "travelers", "preferences"]),
    );
    expect(schema.required).toContain("destination"); // required semantic field
    expect(schema.required ?? []).not.toContain("preferences"); // required: false in CDL
    expect(schema.properties.destination.type).toBe("string"); // location → string
    expect(schema.properties.dates.type).toBe("object"); // date-range → object
  });
});

describe("#16 NF-7: inputJsonSchema lowers IR field kinds (crafted IR)", () => {
  it("an enum scalar lowers to { type: 'string', enum: [...] }", () => {
    const fields: IRField[] = [
      { name: "status", required: true, type: { kind: "scalar", semantic: "enum", values: ["open", "closed"] } },
    ];
    const schema = inputJsonSchema(fields) as {
      properties: Record<string, { type: string; enum?: string[] }>;
      required?: string[];
    };
    expect(schema.properties.status).toMatchObject({ type: "string", enum: ["open", "closed"] });
    expect(schema.required).toContain("status");
  });

  it("a ref/resource field lowers to { type: 'object' }", () => {
    const fields: IRField[] = [{ name: "hotel", required: false, type: { kind: "resource", name: "Hotel" } }];
    const schema = inputJsonSchema(fields) as { properties: Record<string, { type: string }>; required?: string[] };
    expect(schema.properties.hotel.type).toBe("object");
    expect(schema.required ?? []).not.toContain("hotel"); // required: false
  });

  it("a collection field lowers to { type: 'array' }", () => {
    const fields: IRField[] = [{ name: "rooms", required: true, type: { kind: "collection", of: "Room" } }];
    const schema = inputJsonSchema(fields) as {
      properties: Record<string, { type: string; items?: { type: string } }>;
    };
    expect(schema.properties.rooms.type).toBe("array");
    expect(schema.properties.rooms.items?.type).toBe("object");
  });
});

describe("callTool — routing to the REST provider", () => {
  it("invokes the backend and returns its response as content", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    const r = await callTool(
      registry,
      "tourism_search",
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("hotels");
  });

  it("returns an error for an unknown tool", async () => {
    const r = await callTool(registry, "does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });

  it("does not resolve an unbound capability's tool name (NF-6)", async () => {
    // tourism.book exists in booking but has no binding, so it is never emitted
    // as a tool; its sanitized name must be treated as unknown, not routed.
    expect(registry.getCapability("tourism.book")).toBeDefined();
    expect(toolDefinitions(registry).map((d) => d.name)).not.toContain("tourism_book");

    const r = await callTool(registry, "tourism_book", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });
});
