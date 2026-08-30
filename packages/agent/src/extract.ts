// @archstone/agent — the extraction surface (ADR-0011, #11)
//
// The pair to tools()/execute(), pointed the other way. `tools()` describes what a model may
// CALL; this describes what a model must PRODUCE, and judges what it did produce.
//
// Schema and validation are deliberately not two independent calls. Handing a model the schema
// for one resource and validating its answer against another is the call-site form of ADR-0011's
// R-1 — the schema and the judge disagreeing — and an `Extractor` makes it unrepresentable:
// `.schema`, `.tool()`, `.structuredOutput` and `.validate()` all close over the same resource.
//
// PROVIDER ENVELOPES — read at source on 2026-08-30, per this package's standing rule not to
// write a provider's request shape from memory (see tools.ts's own note):
//
//   anthropic   `output_config: { format: { type: "json_schema", schema } }`. The `format`
//               object takes NO name and NO description. Supported schema keywords include
//               `required` and `additionalProperties` — the latter "must be set to false for
//               objects", and anything other than `false` is REJECTED. `date`/`date-time`
//               string formats are supported. **Recursive schemas are not supported**, which
//               is independently the same refusal `extractionJsonSchema` already makes.
//               (platform.claude.com "Structured outputs")
//   openai      `text: { format: { type: "json_schema", name, schema, strict } }` on the
//               Responses API — NOT the older `response_format: { type: "json_schema",
//               json_schema: {...} }` of Chat Completions. `strict` is emitted as **false**
//               by decision: under `strict: true` OpenAI requires every property to appear in
//               `required`, which would delete the `degraded` outcome on this target alone and
//               make the contract stricter on one provider than the manifest says it is. The
//               guarantee here was never that the provider validates — it is that we refuse.
//               (developers.openai.com "Structured model outputs")
//   gemini      `response_format: { type: "text", mime_type: "application/json", schema }` on
//               the Interactions API, not the legacy `generationConfig.responseSchema`. That
//               page lists `additionalProperties` among supported object keywords.
//               (ai.google.dev "Structured output")
//   json-schema Archstone's own neutral shape — `{ schema }`, no provider envelope.
//
// A NOTE ON GEMINI AND ADR-0011 R-2. R-2 says a stripped `additionalProperties` leaves the model
// untold that the object is closed. That applies to the TOOL axis, where `sanitizeGeminiSchema`
// strips it because `GEMINI_ALLOWED_KEYS` (built against the function-calling `Schema` object,
// checked 2026-07-17) does not list it. It appears NOT to apply to the structured-output axis,
// whose own reference does list it. The function-calling reference could not be re-read at the
// address tools.ts cites — so that list is left exactly as it is, and the two axes are simply
// not assumed to share a dialect. Re-verify before changing either.

import { Registry, extractionJsonSchema, validateExtraction, toolName, type ExtractionResult } from "@archstone/emitter-support";
import { toolEnvelope, type ToolDef, type ToolFormat } from "./tools";

type JsonSchema = Record<string, unknown>;

export interface AnthropicStructuredOutput {
  type: "json_schema";
  schema: JsonSchema;
}

export interface OpenAIStructuredOutput {
  type: "json_schema";
  name: string;
  schema: JsonSchema;
  /** Always `false` — see this file's header. */
  strict: false;
}

export interface GeminiStructuredOutput {
  type: "text";
  mime_type: "application/json";
  schema: JsonSchema;
}

/** The neutral shape — no provider envelope — matching `JsonSchemaToolDef`'s role on the
 *  tool axis. */
export interface JsonSchemaStructuredOutput {
  schema: JsonSchema;
}

export type StructuredOutputDef =
  | AnthropicStructuredOutput
  | OpenAIStructuredOutput
  | GeminiStructuredOutput
  | JsonSchemaStructuredOutput;

/** Thrown by `extractor()` for a resource the IR does not declare. Fail-closed and loud: the
 *  alternative is lowering an empty field list, which yields a schema that accepts `{}` and a
 *  validator that reports every key as undeclared — a boundary that silently permits everything
 *  while looking like it is working. */
export class UnknownResourceError extends Error {
  constructor(name: string, known: string[]) {
    super(`unknown resource '${name}'; the artifact declares ${known.length === 0 ? "none" : known.join(", ")}`);
    this.name = "UnknownResourceError";
  }
}

/**
 * One resource, bound to one target format: the schema a model is given, and the boundary its
 * answer passes through. Both axes are available on the same object — a deployer picks whichever
 * their provider call uses, and cannot pick a schema from one resource and a judge from another.
 */
export interface Extractor {
  /** The canonical resource name this extractor is bound to. */
  readonly resource: string;
  /** The closed JSON Schema, with no provider envelope — the same document both accessors
   *  below wrap (`sanitizeGeminiSchema` on the tool axis excepted). */
  readonly schema: JsonSchema;
  /** The native structured-output envelope for this extractor's format. */
  readonly structuredOutput: StructuredOutputDef;
  /**
   * The tool-definition envelope, for extraction performed as a forced tool call.
   *
   * `instruction` is required and is not defaulted. Every provider's tool envelope carries a
   * description, and Archstone has no authored text to put there: a Resource Definition's
   * `description` says what the entity IS, and the IR does not carry it in any case, while what
   * a tool description must say is what to DO on this occasion — "record the stay described in
   * this note" differs from "record the stay this review is about" for one and the same
   * resource. Synthesizing a sentence would be inventing the one field the model reads first.
   */
  tool(instruction: string): ToolDef;
  /** Judge a model's answer. See `ExtractionResult` — this proves shape, never truth. */
  validate(document: unknown): ExtractionResult;
}

function structuredOutputEnvelope(format: ToolFormat, name: string, schema: JsonSchema): StructuredOutputDef {
  switch (format) {
    case "anthropic":
      return { type: "json_schema", schema };
    case "openai":
      return { type: "json_schema", name, schema, strict: false };
    case "gemini":
      return { type: "text", mime_type: "application/json", schema };
    case "json-schema":
      return { schema };
    default:
      // Same discipline as `toolEnvelope`'s floor: reachable only by a caller casting past
      // `ToolFormat`, and it throws here rather than returning undefined into a declared type.
      throw new Error(`structuredOutputEnvelope: unrecognized format: ${String(format)}`);
  }
}

/**
 * Build an `Extractor` for one declared resource (ADR-0011).
 *
 * The schema is lowered once, eagerly — which is also what surfaces an unlowerable resource
 * (unknown or `type:`-recursive) here, at construction, rather than at the moment a model
 * response needs judging.
 */
export function buildExtractor(registry: Registry, resource: string, format: ToolFormat): Extractor {
  const fields = registry.getResource(resource);
  if (!fields) throw new UnknownResourceError(resource, registry.listResources());

  const resources = registry.ir.resources;
  const schema = extractionJsonSchema(fields, resources);
  const name = toolName(resource); // `tourism.Stay` → `tourism_Stay`, the same sanitizer that
  // advertises a capability, so a resource and a tool can never disagree about what is a legal
  // name on a given provider.

  return {
    resource,
    schema,
    structuredOutput: structuredOutputEnvelope(format, name, schema),
    tool: (instruction) => toolEnvelope(format, name, instruction, schema),
    validate: (document) => validateExtraction(fields, document, resources),
  };
}
