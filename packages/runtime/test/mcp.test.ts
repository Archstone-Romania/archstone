import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../src/registry";
import { toolDefinitions, callTool, toolName, inputJsonSchema, objectJsonSchema } from "../src/mcp";
import type { IRField, IRResourceRegistry } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const tourism = resolve(here, "../../../examples/manifests/tourism");
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

describe("#11: outputSchema — typed, described resource lowering", () => {
  const defs = toolDefinitions(buildRegistry(tourism).registry!);
  const search = defs.find((d) => d.name === "tourism_search")!;

  it("emits an outputSchema; collection Stay → array of typed Stay objects", () => {
    const out = search.outputSchema as {
      type: string;
      properties: Record<string, { type: string; items?: { type: string; properties: Record<string, { type: string; description?: string }> } }>;
    };
    expect(out.type).toBe("object");
    const stays = out.properties.stays;
    expect(stays.type).toBe("array");
    // items carry Stay's typed properties — NOT a bare { type: object }.
    const item = stays.items!;
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties)).toEqual(expect.arrayContaining(["name", "location", "pricePerNight", "rating"]));
    expect(item.properties.location.type).toBe("string"); // location semantic → string
    expect(item.properties.location.description).toMatch(/city|region|address/i); // described
  });

  it("cycle-guards a self-referential resource (no infinite expansion)", () => {
    // Node → Node: the emitter must stop at a generic object on the second visit.
    const resources: IRResourceRegistry = {
      Node: [
        { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "next", required: false, type: { kind: "resource", name: "Node" } },
      ],
    };
    const schema = objectJsonSchema(
      [{ name: "root", required: true, type: { kind: "resource", name: "Node" } }],
      resources,
    ) as { properties: Record<string, { properties: Record<string, { properties?: unknown; type: string }> }> };
    const root = schema.properties.root;
    expect(root.properties.id.type).toBe("string"); // first expansion is typed
    expect(root.properties.next.type).toBe("object"); // recursion stops at a generic object
    expect(root.properties.next.properties).toBeUndefined();
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
    // #11 R-4: the raw body is surfaced verbatim as structuredContent (pass-through, unmapped).
    expect(r.structuredContent).toEqual({ hotels: [{ id: "h1" }] });
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

describe("callTool — response mapping (ADD-12, tourism binding has a response:)", () => {
  const tourismReg = buildRegistry(tourism).registry!;

  it("maps the provider body to Stay and drops unmapped fields (structuredContent = outputSchema)", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    // `id` is not part of Stay → dropped by the mapping; structuredContent is the mapped shape.
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] });
  });

  it("fails closed on a missing REQUIRED field — no raw pass-through (D-6)", async () => {
    // pricePerNight (required) absent → VIOLATION; the raw body must NOT leak through.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }] }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/contract violation/i);
    expect(r.content[0].text).toMatch(/pricePerNight/);
    expect(r.structuredContent).toBeUndefined();
  });

  it("degrades on a missing OPTIONAL field — result returned with a note", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", { destination: "Nice" }, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] });
    expect(r.content.some((c) => /degraded/i.test(c.text))).toBe(true);
  });
});
