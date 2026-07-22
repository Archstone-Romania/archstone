// @archstone/agent — tool-definition envelopes per target format (ADD-0008 #28)
//
// Thin wrappers over @archstone/emitter-support's neutral JSON-Schema lowering
// (inputJsonSchema) — every format shares that ONE lowering; only the envelope shape
// differs (CLAUDE.md: "lowering lives only in @archstone/emitter-support, never
// re-implemented"). The advertised `name` itself (sanitized via `toolName()`) now comes
// straight from Registry.invocableTools() (ADD-30 D-3) — this file no longer re-derives
// the invocable filter or re-runs the sanitizer. Gemini additionally needs a dialect-subset
// sanitizer, since its function-calling Schema object is NOT full JSON Schema — see
// sanitizeGeminiSchema below.

import { Registry, inputJsonSchema } from "@archstone/emitter-support";

type JsonSchema = Record<string, unknown>;

export type ToolFormat = "anthropic" | "openai" | "gemini" | "json-schema";

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

/** Gemini's native `FunctionDeclaration` shape is flat — {name, description, parameters} —
 *  unlike OpenAI's `{type:"function", function:{...}}` wrapper (verified against
 *  ai.google.dev/api/caching#FunctionDeclaration, checked 2026-07-17). */
export interface GeminiToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** The neutral shape — no provider envelope — for non-agent-SDK consumers. */
export interface JsonSchemaToolDef {
  name: string;
  description: string;
  schema: JsonSchema;
}

export type ToolDef = AnthropicToolDef | OpenAIToolDef | GeminiToolDef | JsonSchemaToolDef;

/**
 * Gemini's function-calling Schema object is a documented SUBSET of OpenAPI 3.0 schema —
 * verified against the live API reference (ai.google.dev/api/caching#Schema, checked
 * 2026-07-17, per ADD-0008 §4/R-4's explicit instruction not to hand-roll this from
 * memory). Supported keys: type, format, title, description, nullable, enum, maxItems,
 * minItems, properties, required, minProperties, maxProperties, minLength, maxLength,
 * pattern, example, anyOf, propertyOrdering, default, items, minimum, maximum. NOT
 * supported (stripped here): additionalProperties, $ref, allOf, oneOf, if/then/else,
 * const, patternProperties, not, exclusiveMinimum/Maximum, multipleOf, prefixItems.
 *
 * Our own lowering (@archstone/emitter-support's semanticJsonSchema) never emits any of
 * the unsupported keys today, so this pass is a no-op on current output — it exists to
 * fail safe if the lowering ever grows a keyword Gemini's dialect doesn't understand.
 */
const GEMINI_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

export function sanitizeGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: JsonSchema = {};
      for (const [name, propSchema] of Object.entries(value as JsonSchema)) {
        props[name] = sanitizeGeminiSchema(propSchema as JsonSchema);
      }
      out.properties = props;
    } else if (key === "items" && value && typeof value === "object") {
      out.items = sanitizeGeminiSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Lower every invocable capability to `format`'s tool-definition envelope. Reads the
 *  (name, tool) pairs Registry already derived (ADD-30 D-3) instead of re-deriving the
 *  invocable filter or re-running `toolName()` here. */
export function buildToolDefs(registry: Registry, format: ToolFormat): ToolDef[] {
  const resources = registry.ir.resources;
  const tools = registry.invocableTools();

  switch (format) {
    case "anthropic":
      return tools.map(
        ({ name, tool: t }): AnthropicToolDef => ({
          name,
          description: t.description,
          input_schema: inputJsonSchema(t.input, resources),
        }),
      );
    case "openai":
      return tools.map(
        ({ name, tool: t }): OpenAIToolDef => ({
          type: "function",
          function: {
            name,
            description: t.description,
            parameters: inputJsonSchema(t.input, resources),
          },
        }),
      );
    case "gemini":
      return tools.map(
        ({ name, tool: t }): GeminiToolDef => ({
          name,
          description: t.description,
          parameters: sanitizeGeminiSchema(inputJsonSchema(t.input, resources)),
        }),
      );
    case "json-schema":
      return tools.map(
        ({ name, tool: t }): JsonSchemaToolDef => ({
          name,
          description: t.description,
          schema: inputJsonSchema(t.input, resources),
        }),
      );
  }
}
