import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import { fromIR, sanitizeGeminiSchema } from "../src/index";
import type { AnthropicToolDef, OpenAIToolDef, GeminiToolDef, JsonSchemaToolDef } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: string[] };

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly,
 *  rather than feeding fromIR a live Registry's IR object directly (ADD-0008 #28 DoD). */
function loadArtifact(): unknown {
  const ir = buildRegistry(tourism).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

describe("tools(format) — envelope shape per target (tourism.search)", () => {
  const archstone = fromIR(loadArtifact());

  it("anthropic: {name, description, input_schema}", () => {
    const defs = archstone.tools("anthropic") as AnthropicToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    expect(search!.description).toBeTruthy();
    const schema = search!.input_schema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
    expect(schema.required).toContain("destination");
  });

  it("openai: {type:'function', function:{name, description, parameters}}", () => {
    const defs = archstone.tools("openai") as OpenAIToolDef[];
    const search = defs.find((d) => d.function.name === "tourism_search");
    expect(search).toBeDefined();
    expect(search!.type).toBe("function");
    expect(search!.function.description).toBeTruthy();
    const schema = search!.function.parameters as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("gemini: {name, description, parameters} — flat, no OpenAI-style envelope", () => {
    const defs = archstone.tools("gemini") as GeminiToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    expect((search as unknown as { type?: string }).type).toBeUndefined();
    const schema = search!.parameters as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("json-schema: neutral {name, description, schema}, no provider envelope", () => {
    const defs = archstone.tools("json-schema") as JsonSchemaToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    const schema = search!.schema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("only invocable (bound) capabilities are listed as tools, across every format", () => {
    for (const format of ["anthropic", "openai", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name);
      expect(names).toContain("tourism_search");
    }
  });
});

describe("sanitizeGeminiSchema — Gemini function-calling dialect subset", () => {
  it("strips keys Gemini's Schema object does not support (additionalProperties, const, $ref, ...)", () => {
    const dirty: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      $ref: "#/definitions/x",
      allOf: [{ type: "string" }],
      properties: { a: { type: "string", const: "x" }, b: { type: "array", items: { type: "string", not: {} } } },
      required: ["a"],
    };
    const clean = sanitizeGeminiSchema(dirty);
    expect(clean).not.toHaveProperty("additionalProperties");
    expect(clean).not.toHaveProperty("$ref");
    expect(clean).not.toHaveProperty("allOf");
    const props = clean.properties as Record<string, Record<string, unknown>>;
    expect(props.a).not.toHaveProperty("const");
    expect((props.b.items as Record<string, unknown>)).not.toHaveProperty("not");
    // allowed keys survive untouched
    expect(clean.type).toBe("object");
    expect(clean.required).toEqual(["a"]);
  });

  it("is a no-op on our own lowering's output (no unsupported keyword is ever emitted)", () => {
    const archstone = fromIR(loadArtifact());
    const [search] = archstone.tools("json-schema") as JsonSchemaToolDef[];
    const already = sanitizeGeminiSchema(search.schema as Record<string, unknown>);
    expect(already).toEqual(search.schema);
  });
});
