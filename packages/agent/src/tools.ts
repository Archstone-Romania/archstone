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

// #126 — `effect` and these envelopes: why nothing is emitted here.
//
// `@archstone/runtime`'s MCP emitter now lowers a capability's `effect` into MCP tool
// annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`, server.ts's
// `effectAnnotations`), because an MCP client is REMOTE and can act only on what crosses the
// wire. #126 asks for "the equivalent where the target format has one". Each of the four
// formats below was checked against its live reference before concluding, and none has one:
//
//   anthropic    The Messages API tool definition takes `name`/`description`/`input_schema`
//                plus exactly six optional properties — `cache_control`, `strict`,
//                `defer_loading`, `allowed_callers`, `input_examples`,
//                `eager_input_streaming` (platform.claude.com "Tool reference" §Tool
//                definition properties, checked 2026-08-25). None annotates side effects.
//   openai       A function tool is `{type, name, description, parameters, strict}`
//                (developers.openai.com function-calling guide, checked 2026-08-25). Read-only
//                and destructive hints appear in OpenAI's docs ONLY when describing MCP
//                servers/connectors — i.e. they are MCP's annotations, reached through MCP,
//                not a native field of this envelope. Do not be misled by a search result
//                that says otherwise; that conflation is exactly why this was read at source.
//   gemini       `FunctionDeclaration` does carry a `behavior` field, and it is NOT an
//                equivalent: its values are BLOCKING/NON_BLOCKING and they control whether the
//                model waits for the tool response in the Live API — an async-execution
//                concern, not a side-effect annotation (checked 2026-08-25). Mapping
//                `irreversible` onto it would be a category error dressed as a feature.
//   json-schema  Archstone's own neutral envelope, so nothing stops us adding a field — which
//                is precisely why we don't. This consumer is IN-PROCESS and already holds
//                `archstone.registry`; `effect` is one property lookup away on the IR and was
//                never withheld from them. The asymmetry that makes #126 a bug for MCP simply
//                does not exist here, and widening a published type to restate a fact the
//                caller can already read would be an unratified API change, not a fix.
//
// So: no invention, in either direction — `tools()` gains no field, and no format gets a
// hand-rolled stand-in. `test/tools.test.ts` pins each envelope's exact key set so that a
// future contributor adding one has to change a test that says why it is absent. Revisit per
// format, against that format's live reference, if a provider ships a real equivalent.

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
 *  invocable filter or re-running `toolName()` here.
 *
 *  ADD-24 (#55): mirrors `@archstone/runtime`'s `toolDefinitions()` (server.ts) — the shared
 *  `registry.getExposure` (ADD-24 D-6/R-5) is consulted here too, so this, the OTHER surface
 *  that tells a host what capabilities exist, is no longer lifecycle-blind. A bound tool whose
 *  exposure is `listed:false` (lifecycle `experimental`/`retired`) is dropped from the returned
 *  list entirely, exactly as the MCP path drops it. A tool carrying a `hint` (beta/deprecated,
 *  or a yellow/red health reading) has its text appended to `description` — the only
 *  per-format-envelope rendering of the neutral exposure emitter-support computed. */
export function buildToolDefs(registry: Registry, format: ToolFormat): ToolDef[] {
  const resources = registry.ir.resources;
  const tools = registry
    .invocableTools()
    .filter(({ tool: t }) => registry.getExposure(t.id).listed);
  const describe = (t: (typeof tools)[number]["tool"]): string => {
    const hint = registry.getExposure(t.id).hint;
    return hint ? `${t.description} (${hint.text})` : t.description;
  };

  switch (format) {
    case "anthropic":
      return tools.map(
        ({ name, tool: t }): AnthropicToolDef => ({
          name,
          description: describe(t),
          input_schema: inputJsonSchema(t.input, resources),
        }),
      );
    case "openai":
      return tools.map(
        ({ name, tool: t }): OpenAIToolDef => ({
          type: "function",
          function: {
            name,
            description: describe(t),
            parameters: inputJsonSchema(t.input, resources),
          },
        }),
      );
    case "gemini":
      return tools.map(
        ({ name, tool: t }): GeminiToolDef => ({
          name,
          description: describe(t),
          parameters: sanitizeGeminiSchema(inputJsonSchema(t.input, resources)),
        }),
      );
    case "json-schema":
      return tools.map(
        ({ name, tool: t }): JsonSchemaToolDef => ({
          name,
          description: describe(t),
          schema: inputJsonSchema(t.input, resources),
        }),
      );
    default:
      // ADD-56 D-5: zero-risk hardening, NOT a fix to a reachable defect. `format` is supplied
      // directly by the trusted host program calling `tools(format)` — it never originates from
      // a `fromIR` artifact or any other externally-sourced data (unlike `lifecycle`, ADD-56's
      // actual defect). Reachable only by a caller bypassing this package's own `ToolFormat`
      // type checking (an `as`/`any` cast on a value it constructs itself). Before this branch,
      // that case silently returned `undefined` where `ToolDef[]` is declared, crashing the
      // caller downstream on `.map`/spread instead of here, with a clear cause.
      throw new Error(`buildToolDefs: unrecognized tool format: ${String(format)}`);
  }
}
