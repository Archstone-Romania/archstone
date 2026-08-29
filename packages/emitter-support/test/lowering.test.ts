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

describe("#8: a semantic type's description never overwrites the authored one", () => {
  // `location` is the only semantic type that ships a description today, which is why this
  // defect looked like working code on every other field. The assertions below pin the RULE,
  // not the one case: the second test proves the fallback still applies, so a semantic type
  // that gains a description later is covered in both directions.
  const described: IRField[] = [
    {
      name: "location",
      required: true,
      description: "Where the stay is — city, region, or address.",
      type: { kind: "scalar", semantic: "location" },
    },
  ];

  it("keeps the manifest's own sentence", () => {
    const schema = objectJsonSchema(described) as { properties: Record<string, { description: string }> };
    expect(schema.properties.location.description).toBe("Where the stay is — city, region, or address.");
  });

  it("falls back to the semantic type's text when the field declares none", () => {
    const bare: IRField[] = [{ name: "location", required: true, type: { kind: "scalar", semantic: "location" } }];
    const schema = objectJsonSchema(bare) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.location.description).toBe("A place — city, region, or address.");
  });

  it("overrides the description only — every other key stays semantic-owned", () => {
    const money: IRField[] = [
      { name: "price", required: true, description: "What the guest pays.", type: { kind: "scalar", semantic: "money" } },
    ];
    const schema = objectJsonSchema(money) as {
      properties: Record<string, { description: string; type: string; required: string[] }>;
    };
    expect(schema.properties.price.description).toBe("What the guest pays.");
    expect(schema.properties.price.type).toBe("object"); // not clobbered by `base`
    expect(schema.properties.price.required).toEqual(["amount", "currency"]);
  });

  it("emits `description` first, so key order is unchanged for fields this does not affect", () => {
    const schema = objectJsonSchema(described) as { properties: Record<string, object> };
    expect(Object.keys(schema.properties.location)).toEqual(["description", "type"]);
  });
});
