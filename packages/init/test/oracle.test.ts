import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { diffIR, emit, formatDiff, type DecisionRecord, type IRDiff } from "@archstone/init";
import { commitFileSet, compileForDiff } from "@archstone/init/loop";
import { arrayOf, draftModel, inputField, objectNode, operation, property, scalarNode } from "./draft";

// THE WHOLE INCREMENT, END TO END, WITH A NUMBER ATTACHED.
//
// A Draft Model of the kind an adapter will produce → `emit` → the closed loop → the real
// compiler → the diff harness, against a hand-written manifest nobody generated. When this is
// clean, steps 2, 3 and 4 are demonstrably wired to each other rather than merely each passing
// their own unit tests.
//
// HONEST LABEL, because the ADD is emphatic about oracle contamination: this Draft Model was
// hand-written by someone who had read the oracle, so what it measures is EMISSION FIDELITY —
// given correct facts, does the generator produce the manifest a careful human produced? It
// does NOT measure inference quality, which is a property of an adapter (step 5) and is
// measurable only against a source nobody authored for the purpose.

const here = dirname(fileURLToPath(import.meta.url));
const ORACLE = resolve(here, "fixtures/oracle");

const listParts = operation("GET", "/api/v1/parts", {
  description: "Returns the catalogue of parts.",
  response: objectNode([
    property(
      "items",
      arrayOf(
        objectNode(
          [
            // `nullable: false` is not decoration: D-12 requires POSITIVE evidence of
            // non-nullability before `required: true`, and a real adapter must set it
            // wherever its source establishes it (a 3.1 `type` that excludes `null`, a
            // resolved 3.0 schema without `nullable: true`). Leaving it absent here would
            // make all three optional, and DoD-3(d) would say so.
            property("id", scalarNode({ type: "identifier", nullable: false, source: "Part.id", example: "P-1", description: "Stable identifier for this part." }), { declaredRequired: true }),
            property("name", scalarNode({ type: "text", nullable: false, source: "Part.name", example: "Steel bracket", description: "Display name of the part." }), { declaredRequired: true }),
            property("material", scalarNode({ type: "enum", nullable: false, values: ["steel", "aluminium", "composite"], source: "Part.material", example: "steel" }), { declaredRequired: true }),
            property("description", scalarNode({ type: "text", source: "Part.description" }), { declaredRequired: false }),
            property("widthMm", scalarNode({ type: "quantity", source: "Part.widthMm", example: 40 }), { declaredRequired: false }),
            property("pricePerUnit", scalarNode({ type: "quantity", source: "Part.pricePerUnit", example: 12.5 }), { declaredRequired: false }),
          ],
          { name: "Part", description: "A part Acme can supply." },
        ),
      ),
    ),
  ]),
});

const estimatePrice = operation("GET", "/api/v1/parts/{partId}/price", {
  description: "Returns a price estimate.",
  input: [
    inputField("partId", "path", { type: "identifier", description: "The part to price." }),
    inputField("widthCm", "query", { type: "quantity", wireName: "width_cm", required: true }),
    inputField("heightCm", "query", { type: "quantity", wireName: "height_cm", required: true }),
  ],
  response: objectNode(
    [
      // Declared required by the source, but nullable — §1.2 turns that into `required: false`,
      // which is exactly the classification the human reached by hand.
      property("estimatedPrice", scalarNode({ type: "quantity", nullable: true, source: "Estimate.estimatedPrice", example: 250 }), { declaredRequired: true }),
      property("currency", scalarNode({ type: "string", nullable: false, source: "Estimate.currency", example: "RON" }), { declaredRequired: true }),
    ],
    { name: "PartPriceEstimate", description: "An estimated price for one part at one size." },
  ),
});

const decisions: DecisionRecord = {
  version: "0",
  company: { id: "acme", name: "Acme Parts", description: "A parts supplier exposing its catalog and pricing to AI agents." },
  decisions: [
    { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
    { operation: "GET /api/v1/parts/{partId}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
  ],
};

let workspace: string;
let diff: IRDiff;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "archstone-init-oracle-"));
  const emitted = emit(draftModel([listParts, estimatePrice], { source: { adapter: "test", origin: "the oracle's backend" } }), decisions);
  const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
  expect(committed.failures).toEqual([]);
  diff = diffIR(compileForDiff(ORACLE), committed.ir!);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("generated versus hand-written — the four measured items", () => {
  it("(a) both capabilities discovered, no extras", () => {
    expect(diff.matched).toHaveLength(2);
    expect(diff.missingTools).toEqual([]);
    expect(diff.extraTools).toEqual([]);
  });

  it("(b) `effect` matches on both — from the Decision Record, never inferred", () => {
    expect(diff.effectDivergences).toEqual([]);
  });

  it("(c) every response.map JSONPath matches", () => {
    expect(diff.responseFieldDivergences).toEqual([]);
  });

  it("(d) every required/optional classification matches, including the nullable case", () => {
    expect(diff.requiredDivergences).toEqual([]);
  });

  it("the request the provider would build matches on both", () => {
    expect(diff.requestDivergences).toEqual([]);
  });

  it("clean — a zero on all four", () => {
    expect(diff.clean, formatDiff(diff)).toBe(true);
  });
});

describe("generated versus hand-written — what is recorded but excluded", () => {
  it("the `ref:` → `identifier` degradation appears as a named known miss", () => {
    expect(diff.knownMisses).toEqual([
      expect.objectContaining({ code: "identity-ref-not-inferred", field: "partId" }),
    ]);
  });

  it("the description delta is recorded verbatim, and does not affect the pass criterion", () => {
    expect(diff.namingDeltas.length).toBeGreaterThan(0);
    expect(diff.namingDeltas.every((d) => d.expectedId === d.actualId)).toBe(true);
    expect(diff.clean).toBe(true);
  });
});
