import { describe, it, expect } from "vitest";
import { toolName, inputJsonSchema, objectJsonSchema } from "../src/lowering";
import type { IRField, IRResourceRegistry } from "@archstone/compiler";

describe("toolName", () => {
  it("sanitizes capability ids to MCP tool names", () => {
    expect(toolName("tourism.search")).toBe("tourism_search");
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

describe("#25 identity fields lower to a bare string, not the full resource", () => {
  it("a `ref:`-originated (identity: true) field lowers to { type: 'string' }, not the object", () => {
    const resources: IRResourceRegistry = {
      FrameProfile: [
        { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "material", required: true, type: { kind: "scalar", semantic: "string" } },
      ],
    };
    const fields: IRField[] = [
      {
        name: "frameProfileId",
        required: true,
        description: "The frame profile to price.",
        type: { kind: "resource", name: "FrameProfile", identity: true },
      },
    ];
    const schema = inputJsonSchema(fields, resources) as {
      properties: Record<string, { type: string; description?: string; properties?: unknown }>;
    };
    expect(schema.properties.frameProfileId).toEqual({ type: "string", description: "The frame profile to price." });
    expect(schema.properties.frameProfileId.properties).toBeUndefined();
  });

  it("a nested `ref:`-originated field inside a resource's own field map also lowers to a bare string (R-3)", () => {
    // Order.customerId: { ref: Customer } — the resource registry itself holds a resource
    // whose field is identity-shaped, exercised via the same lowerFields/fieldJsonSchema path.
    const resources: IRResourceRegistry = {
      Customer: [{ name: "name", required: true, type: { kind: "scalar", semantic: "string" } }],
      Order: [
        { name: "reference", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "customerId", required: true, type: { kind: "resource", name: "Customer", identity: true } },
      ],
    };
    const schema = objectJsonSchema(
      [{ name: "order", required: true, type: { kind: "resource", name: "Order" } }],
      resources,
    ) as { properties: Record<string, { properties: Record<string, { type: string; properties?: unknown }> }> };
    const order = schema.properties.order;
    expect(order.properties.customerId).toEqual({ type: "string" });
    expect(order.properties.customerId.properties).toBeUndefined();
  });
});

describe("objectJsonSchema — resource cycle guard", () => {
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
