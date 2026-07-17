// @archstone/agent — tool-definition envelopes per target format (ADD-0008 #28)
//
// Thin wrappers over @archstone/emitter-support's neutral JSON-Schema lowering
// (inputJsonSchema / toolName) — every format shares that ONE lowering; only the
// envelope shape differs (CLAUDE.md: "lowering lives only in @archstone/emitter-support,
// never re-implemented"). Gemini additionally needs a dialect-subset sanitizer, since its
// function-calling Schema object is NOT full JSON Schema — see sanitizeGeminiSchema below.

import type { IRTool } from "@archstone/compiler";
import { Registry, inputJsonSchema, toolName } from "@archstone/emitter-support";

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
 * Only invocable (bound) capabilities become tools — mirrors @archstone/runtime's
 * `emittedTools` filter (`server.ts`): an unbound capability has no connector for
 * execute() to call, so it has nothing to offer an agent either.
 */
function emittedTools(registry: Registry): IRTool[] {
  return registry.listCapabilities().filter((t) => t.connector);
}

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

/** Lower every invocable capability to `format`'s tool-definition envelope. */
export function buildToolDefs(registry: Registry, format: ToolFormat): ToolDef[] {
  const resources = registry.ir.resources;
  const tools = emittedTools(registry);

  switch (format) {
    case "anthropic":
      return tools.map(
        (t): AnthropicToolDef => ({
          name: toolName(t.id),
          description: t.description,
          input_schema: inputJsonSchema(t.input, resources),
        }),
      );
    case "openai":
      return tools.map(
        (t): OpenAIToolDef => ({
          type: "function",
          function: {
            name: toolName(t.id),
            description: t.description,
            parameters: inputJsonSchema(t.input, resources),
          },
        }),
      );
    case "gemini":
      return tools.map(
        (t): GeminiToolDef => ({
          name: toolName(t.id),
          description: t.description,
          parameters: sanitizeGeminiSchema(inputJsonSchema(t.input, resources)),
        }),
      );
    case "json-schema":
      return tools.map(
        (t): JsonSchemaToolDef => ({
          name: toolName(t.id),
          description: t.description,
          schema: inputJsonSchema(t.input, resources),
        }),
      );
  }
}
