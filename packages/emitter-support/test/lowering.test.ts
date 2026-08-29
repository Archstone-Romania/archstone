import { describe, it, expect } from "vitest";
import { toolName, inputJsonSchema, objectJsonSchema, extractionJsonSchema, ExtractionSchemaError } from "../src/lowering";
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

describe("#7 / ADR-0011: extractionJsonSchema — a CLOSED schema, alongside the open one", () => {
  const resources: IRResourceRegistry = {
    "tourism.Stay": [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
    ],
  };

  it("closes the root object", () => {
    const schema = extractionJsonSchema([{ name: "n", required: true, type: { kind: "scalar", semantic: "text" } }]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("closes an expanded resource-typed field", () => {
    const fields: IRField[] = [{ name: "stay", required: true, type: { kind: "resource", name: "tourism.Stay" } }];
    const schema = extractionJsonSchema(fields, resources) as {
      properties: Record<string, { additionalProperties?: boolean }>;
    };
    expect(schema.properties.stay.additionalProperties).toBe(false);
  });

  it("closes the items of a collection", () => {
    const fields: IRField[] = [{ name: "stays", required: true, type: { kind: "collection", of: "tourism.Stay" } }];
    const schema = extractionJsonSchema(fields, resources) as {
      properties: Record<string, { items: { additionalProperties?: boolean } }>;
    };
    expect(schema.properties.stays.items.additionalProperties).toBe(false);
  });

  it("closes the composite semantic shapes (money, party, date-range)", () => {
    const fields: IRField[] = [
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "who", required: true, type: { kind: "scalar", semantic: "party" } },
      { name: "when", required: true, type: { kind: "scalar", semantic: "date-range" } },
    ];
    const schema = extractionJsonSchema(fields) as { properties: Record<string, { additionalProperties?: boolean }> };
    for (const f of ["price", "who", "when"]) expect(schema.properties[f].additionalProperties).toBe(false);
  });

  it("leaves a `ref:` field a bare string — identity is never expanded, so nothing to close", () => {
    const fields: IRField[] = [{ name: "hotel", required: true, type: { kind: "resource", name: "Hotel", identity: true } }];
    const schema = extractionJsonSchema(fields, resources) as { properties: Record<string, { type: string }> };
    expect(schema.properties.hotel.type).toBe("string");
  });

  it("agrees with the open lowering on type, required and description — only closure differs", () => {
    const fields: IRField[] = [
      { name: "name", required: true, description: "The property's display name.", type: { kind: "scalar", semantic: "text" } },
      { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const open = objectJsonSchema(fields) as Record<string, unknown>;
    const strict = extractionJsonSchema(fields) as Record<string, unknown>;
    const { additionalProperties, ...rest } = strict;
    expect(additionalProperties).toBe(false);
    expect(rest).toEqual(open);
  });

  it("refuses a self-referential resource instead of degrading to an open object", () => {
    const cyclic: IRResourceRegistry = {
      Node: [{ name: "child", required: false, type: { kind: "resource", name: "Node" } }],
    };
    const fields: IRField[] = [{ name: "root", required: true, type: { kind: "resource", name: "Node" } }];
    expect(() => extractionJsonSchema(fields, cyclic)).toThrow(ExtractionSchemaError);
    // …where the open lowering still degrades, unchanged.
    expect(() => objectJsonSchema(fields, cyclic)).not.toThrow();
  });

  it("refuses an unknown resource name instead of emitting an open object", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    expect(() => extractionJsonSchema(fields, {})).toThrow(/not in the registry/);
  });
});

describe("#7: the open lowering is untouched by the strict one", () => {
  // The pin. `objectJsonSchema`/`inputJsonSchema` output is a published wire shape reached by
  // every shipped manifest — this fails if adding the extraction path changed a byte of it.
  it("emits no additionalProperties anywhere, at any depth", () => {
    const resources: IRResourceRegistry = {
      Room: [{ name: "beds", required: true, type: { kind: "scalar", semantic: "quantity" } }],
    };
    const fields: IRField[] = [
      { name: "rooms", required: true, type: { kind: "collection", of: "Room" } },
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "who", required: false, type: { kind: "scalar", semantic: "party" } },
    ];
    expect(JSON.stringify(objectJsonSchema(fields, resources))).not.toContain("additionalProperties");
    expect(JSON.stringify(inputJsonSchema(fields, resources))).not.toContain("additionalProperties");
  });

  it("still degrades an unknown resource to a generic object rather than throwing", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    const schema = objectJsonSchema(fields, {}) as { properties: Record<string, { type: string }> };
    expect(schema.properties.x.type).toBe("object");
  });
});
