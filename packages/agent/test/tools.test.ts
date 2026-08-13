import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry } from "@archstone/runtime";
import { fromIR, sanitizeGeminiSchema } from "../src/index";
import type { AnthropicToolDef, OpenAIToolDef, GeminiToolDef, JsonSchemaToolDef } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** One capability per lifecycle state, all bound to the same (unreachable — never invoked in
 *  these tests) backend — mirrors packages/runtime/test/lifecycle.integration.test.ts's fixture
 *  so `buildToolDefs`'s exposure filtering is exercised the same way `toolDefinitions()`'s is. */
const LIFECYCLES = ["stable", "beta", "deprecated", "experimental", "retired"] as const;

function writeLifecycleManifest(dir: string): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    [
      "company:",
      "  id: demo",
      "capabilities:",
      ...LIFECYCLES.map((l) => `  - demo.${l}`),
      "providers:",
      "  - acme",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "bindings"));
  for (const l of LIFECYCLES) {
    writeFileSync(
      join(dir, `demo.${l}.capability.yaml`),
      [
        "capability:",
        `  id: demo.${l}`,
        `  description: A ${l} capability.`,
        "  effect: read",
        "  provider: acme",
        `  lifecycle: ${l}`,
        "  output:",
        "    value:",
        "      type: string",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "bindings", `demo.${l}.binding.yaml`),
      [
        "binding:",
        `  capabilityId: demo.${l}`,
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${DEMO_API_URL}"',
        "      method: GET",
        "      path: /x",
        "",
      ].join("\n"),
    );
  }
}

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

describe("#55: tools()/buildToolDefs honour capability exposure/lifecycle (ADD-24 D-6/R-5)", () => {
  let dir: string;
  let archstone: ReturnType<typeof fromIR>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "archstone-agent-lifecycle-"));
    writeLifecycleManifest(dir);
    const built = buildRegistry(dir);
    if (!built.ok || !built.registry) {
      throw new Error(`fixture manifest failed to build: ${JSON.stringify(built.diagnostics)}`);
    }
    archstone = fromIR(JSON.parse(JSON.stringify(built.registry.ir)));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists exactly stable, beta, deprecated — retired and experimental are unlisted (D-10), across every format", () => {
    for (const format of ["anthropic", "openai", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name).sort();
      expect(names).toEqual(["demo_beta", "demo_deprecated", "demo_stable"]);
    }
  });

  it("stable has no hint; beta/deprecated carry their lifecycle hint text in the description", () => {
    const defs = archstone.tools("anthropic") as AnthropicToolDef[];
    const byName = new Map(defs.map((d) => [d.name, d.description]));
    expect(byName.get("demo_stable")).toBe("A stable capability.");
    expect(byName.get("demo_beta")).toContain("beta");
    expect(byName.get("demo_deprecated")).toContain("deprecated");
  });

  it("a retired capability never reaches any format's tool list", () => {
    for (const format of ["anthropic", "openai", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name);
      expect(names).not.toContain("demo_retired");
    }
  });
});
