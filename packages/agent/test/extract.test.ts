import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import { fromIR, UnknownResourceError } from "../src/index";
import type {
  AnthropicToolDef,
  OpenAIToolDef,
  GeminiToolDef,
  JsonSchemaToolDef,
  AnthropicStructuredOutput,
  OpenAIStructuredOutput,
  GeminiStructuredOutput,
  JsonSchemaStructuredOutput,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** As in tools.test.ts: IR round-tripped through JSON, exactly as `archstone build` ships it. */
function loadArtifact(): unknown {
  return JSON.parse(JSON.stringify(buildRegistry(tourism).registry!.ir));
}

const archstone = fromIR(loadArtifact());
const INSTRUCTION = "Record the stay described in this booking email.";

/** The shipped resource: name/location/pricePerNight required, rating optional. */
const STAY = { name: "Casa Verde", location: "Brașov", pricePerNight: 320, rating: 4.6 };

describe("#11 / ADR-0011: extractor() binds one resource to one format", () => {
  it("carries the resource name and a CLOSED schema", () => {
    const stay = archstone.extractor("tourism.Stay", "json-schema");
    expect(stay.resource).toBe("tourism.Stay");
    expect(stay.schema.additionalProperties).toBe(false);
    expect(stay.schema.required).toEqual(["name", "location", "pricePerNight"]);
  });

  it("carries the manifest's own description, not the semantic type's generic one (#8)", () => {
    const stay = archstone.extractor("tourism.Stay", "json-schema");
    const props = stay.schema.properties as Record<string, { description: string }>;
    expect(props.location.description).toBe("Where the stay is — city, region, or address.");
  });

  it("fails closed and loudly on a resource the artifact does not declare", () => {
    expect(() => archstone.extractor("clinic.Encounter", "anthropic")).toThrow(UnknownResourceError);
    // …and names what IS declared, so the caller can see the typo rather than guess.
    expect(() => archstone.extractor("clinic.Encounter", "anthropic")).toThrow(/tourism\.Stay/);
  });
});

describe("#11: the structured-output envelope, per provider", () => {
  it("anthropic — { type, schema }, no name, no description (output_config.format)", () => {
    const so = archstone.extractor("tourism.Stay", "anthropic").structuredOutput as AnthropicStructuredOutput;
    expect(Object.keys(so).sort()).toEqual(["schema", "type"]);
    expect(so.type).toBe("json_schema");
    // Anthropic REQUIRES additionalProperties:false for objects — our lowering already emits it.
    expect(so.schema.additionalProperties).toBe(false);
  });

  it("openai — { type, name, schema, strict:false } (text.format on the Responses API)", () => {
    const so = archstone.extractor("tourism.Stay", "openai").structuredOutput as OpenAIStructuredOutput;
    expect(Object.keys(so).sort()).toEqual(["name", "schema", "strict", "type"]);
    expect(so.name).toBe("tourism_Stay");
    // `strict: false` is a decision, not an omission: strict mode would require every property
    // in `required`, deleting the `degraded` outcome on this target alone.
    expect(so.strict).toBe(false);
  });

  it("gemini — { type:'text', mime_type, schema } (response_format on the Interactions API)", () => {
    const so = archstone.extractor("tourism.Stay", "gemini").structuredOutput as GeminiStructuredOutput;
    expect(so).toMatchObject({ type: "text", mime_type: "application/json" });
    // The structured-output reference lists additionalProperties as supported, so unlike the
    // tool axis below it is NOT stripped here. ADR-0011 R-2 is axis-specific.
    expect(so.schema.additionalProperties).toBe(false);
  });

  it("json-schema — the neutral shape, no envelope", () => {
    const so = archstone.extractor("tourism.Stay", "json-schema").structuredOutput as JsonSchemaStructuredOutput;
    expect(Object.keys(so)).toEqual(["schema"]);
  });
});

describe("#11: the tool envelope reuses the shipped four, and requires an instruction", () => {
  it("anthropic", () => {
    const def = archstone.extractor("tourism.Stay", "anthropic").tool(INSTRUCTION) as AnthropicToolDef;
    expect(def).toMatchObject({ name: "tourism_Stay", description: INSTRUCTION });
    expect(def.input_schema.additionalProperties).toBe(false);
  });

  it("openai", () => {
    const def = archstone.extractor("tourism.Stay", "openai").tool(INSTRUCTION) as OpenAIToolDef;
    expect(def.type).toBe("function");
    expect(def.function).toMatchObject({ name: "tourism_Stay", description: INSTRUCTION });
  });

  it("json-schema", () => {
    const def = archstone.extractor("tourism.Stay", "json-schema").tool(INSTRUCTION) as JsonSchemaToolDef;
    expect(def).toMatchObject({ name: "tourism_Stay", description: INSTRUCTION });
  });

  it("gemini strips additionalProperties on the TOOL axis — ADR-0011 R-2, made concrete", () => {
    const def = archstone.extractor("tourism.Stay", "gemini").tool(INSTRUCTION) as GeminiToolDef;
    // GEMINI_ALLOWED_KEYS (function-calling Schema subset) does not list additionalProperties,
    // so the sanitizer removes it: the model is not TOLD the object is closed…
    expect(def.parameters.additionalProperties).toBeUndefined();
    // …and validate() closes it regardless. That is the whole of R-2: a quality difference on
    // one axis of one provider, never a safety one.
    const r = archstone.extractor("tourism.Stay", "gemini").validate({ ...STAY, invented: 1 });
    expect(r.undeclared).toEqual(["invented"]);
    expect(r.data).toEqual(STAY);
  });
});

describe("#11: validate() is the same boundary, reached through the extractor", () => {
  const stay = archstone.extractor("tourism.Stay", "anthropic");

  it("ok", () => {
    expect(stay.validate(STAY)).toEqual({ status: "ok", data: STAY });
  });

  it("degraded — the optional rating is absent", () => {
    const { rating: _dropped, ...withoutRating } = STAY;
    expect(stay.validate(withoutRating)).toMatchObject({ status: "degraded", degraded: ["rating"] });
  });

  it("violation — a required field is absent, and the document is withheld", () => {
    const { pricePerNight: _dropped, ...withoutPrice } = STAY;
    const r = stay.validate(withoutPrice);
    expect(r.status).toBe("violation");
    expect(r.data).toBeUndefined();
  });

  it("an undeclared key is dropped and named, without moving status", () => {
    const r = stay.validate({ ...STAY, confidence: 0.9 });
    expect(r).toMatchObject({ status: "ok", undeclared: ["confidence"] });
    expect(r.data).toEqual(STAY);
  });
});

describe("#11: an extraction is not an invocation", () => {
  it("emits no Execution record — ADR-0011 rejects it explicitly", async () => {
    // The audit sink is an ExecuteOptions concern and there is no way to pass one here: the
    // extractor takes no options at all. Asserted structurally so nobody later adds one as an
    // obvious-looking improvement — an extraction calls no provider, has no `effect`, and
    // evaluates no policy, so an Execution record about it would make the record's own
    // definition false.
    const stay = archstone.extractor("tourism.Stay", "anthropic");
    expect(Object.keys(stay).sort()).toEqual(["resource", "schema", "structuredOutput", "tool", "validate"]);
    expect(stay.validate(STAY)).not.toHaveProperty("record");
  });
});
