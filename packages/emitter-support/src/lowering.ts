// @archstone/emitter-support — semantic-type → JSON-Schema lowering
//
// Moved out of @archstone/runtime's mcp.ts (ADD-0008 #27), unchanged logic. This is the
// ONLY place semantic types get lowered to JSON Schema — every format an emitter targets
// (MCP's inputSchema/outputSchema today; Anthropic/OpenAI/Gemini tool envelopes later)
// shares this, never re-implements it. No MCP SDK here — the SDK-specific tool shape
// (McpToolDef) stays in @archstone/runtime.

import type { IRField, IRResourceRegistry, SemanticType } from "@archstone/compiler";

type JsonSchema = Record<string, unknown>;

/** MCP tool names are stricter than capability ids — sanitize `tourism.search` → `tourism_search`. */
export function toolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function semanticJsonSchema(semantic: SemanticType, values?: string[]): JsonSchema {
  switch (semantic) {
    case "location":
      return { type: "string", description: "A place — city, region, or address." };
    case "date-range":
      return {
        type: "object",
        properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } },
        required: ["from", "to"],
      };
    case "party":
      return {
        type: "object",
        properties: { adults: { type: "integer" }, children: { type: "integer" } },
        required: ["adults"],
      };
    case "preference-set":
      return { type: "array", items: { type: "string" } };
    case "money":
      return {
        type: "object",
        properties: { amount: { type: "number" }, currency: { type: "string" } },
        required: ["amount", "currency"],
      };
    case "time-slot":
    case "datetime":
      return { type: "string", format: "date-time" };
    case "date":
      return { type: "string", format: "date" };
    case "quantity":
      return { type: "number" };
    case "enum":
      return { type: "string", enum: values ?? [] };
    case "identifier":
    case "string":
    case "text":
    default:
      return { type: "string" };
  }
}

/**
 * Lower a resolved resource (looked up by canonical name in the registry) to a typed,
 * described object schema. `visited` guards against recursive/self-referential resources
 * (R-3): a name already being expanded stops at a generic `{type:object}`. An unknown name
 * (validation floor) also degrades to `{type:object}` rather than crashing.
 */
function resourceJsonSchema(name: string, resources: IRResourceRegistry, visited: ReadonlySet<string>): JsonSchema {
  const fields = resources[name];
  if (!fields || visited.has(name)) return { type: "object" };
  const next = new Set(visited).add(name);
  return objectJsonSchema(fields, resources, next);
}

function fieldJsonSchema(f: IRField, resources: IRResourceRegistry, visited: ReadonlySet<string>): JsonSchema {
  const base: JsonSchema = f.description ? { description: f.description } : {};
  if (f.type.kind === "collection") return { ...base, type: "array", items: resourceJsonSchema(f.type.of, resources, visited) };
  if (f.type.kind === "resource") {
    // `ref:`-originated ("by identity") fields are a bare id — never expand through the
    // resource registry (ADD-25 D-2). `type:`/resource-typed ("by representation") fields
    // keep the existing full-object lowering.
    if (f.type.identity) return { ...base, type: "string" };
    return { ...base, ...resourceJsonSchema(f.type.name, resources, visited) };
  }
  return { ...base, ...semanticJsonSchema(f.type.semantic, f.type.values) };
}

/** Lower an IR field list to a JSON Schema object, resolving resource/collection field
 *  types through the registry (typed, described). Used for both input and output schemas. */
export function objectJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}, visited: ReadonlySet<string> = new Set()): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldJsonSchema(f, resources, visited);
    if (f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Lower IR input fields to a JSON Schema object (the tool's inputSchema). */
export function inputJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}): JsonSchema {
  return objectJsonSchema(fields, resources);
}
