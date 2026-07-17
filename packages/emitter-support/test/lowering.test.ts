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
