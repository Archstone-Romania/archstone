import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffIR, formatDiff } from "@archstone/init";
import { compileForDiff } from "@archstone/init/loop";
import type { IR } from "@archstone/compiler";

// ADD-37 §6 step 4. The harness compares COMPILED IRs and joins tools by CONNECTOR, never by
// id. Every test below is a statement about one of those two decisions.
//
// Mutations are applied to a compiled IR rather than to a second fixture directory on purpose:
// "what if the generated manifest differed in exactly this one way" is the question the harness
// answers, and expressing it as a one-line edit keeps each test's claim visible.

const here = dirname(fileURLToPath(import.meta.url));
const ORACLE = resolve(here, "fixtures/oracle");

const oracle = compileForDiff(ORACLE);
const clone = (ir: IR): IR => structuredClone(ir);
const toolAt = (ir: IR, id: string) => ir.tools.find((t) => t.id === id)!;

describe("the harness — self against self", () => {
  it("reports a clean zero on all four items for the oracle manifest", () => {
    const diff = diffIR(oracle, clone(oracle));
    expect(diff.clean).toBe(true);
    expect(diff.matched).toHaveLength(2);
    expect(diff.missingTools).toEqual([]);
    expect(diff.extraTools).toEqual([]);
    expect(diff.effectDivergences).toEqual([]);
    expect(diff.responseFieldDivergences).toEqual([]);
    expect(diff.requiredDivergences).toEqual([]);
    expect(formatDiff(diff)).toContain("RESULT: clean");
  });

  it("reports a clean zero for a shipped demo manifest too", () => {
    const tourism = compileForDiff("examples/manifests/tourism");
    expect(diffIR(tourism, clone(tourism)).clean).toBe(true);
  });
});

describe("the harness — the four measured items actually fire", () => {
  it("(a) a missing tool is itemized by connector, not by id", () => {
    const actual = clone(oracle);
    actual.tools = actual.tools.filter((t) => t.id !== "catalog.list-parts");
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(false);
    expect(diff.missingTools).toEqual([{ id: "catalog.list-parts", connector: "GET /api/v1/parts" }]);
  });

  it("(a) an extra tool is itemized and counted", () => {
    const actual = clone(oracle);
    const extra = structuredClone(toolAt(actual, "catalog.list-parts"));
    extra.id = "catalog.list-kits";
    extra.connector!.rest!.path = "/api/v1/kits";
    actual.tools.push(extra);
    const diff = diffIR(oracle, actual);
    expect(diff.extraTools).toEqual([{ id: "catalog.list-kits", connector: "GET /api/v1/kits" }]);
  });

  it("(b) a wrong effect fails — the single most consequential field a generator can get wrong", () => {
    const actual = clone(oracle);
    toolAt(actual, "catalog.list-parts").effect = "write";
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(false);
    expect(diff.effectDivergences).toEqual([{ connector: "GET /api/v1/parts", expected: "read", actual: "write" }]);
  });

  it("(c) a changed JSONPath fails, and field ORDER does not", () => {
    const reordered = clone(oracle);
    toolAt(reordered, "catalog.list-parts").response!.fields.reverse();
    expect(diffIR(oracle, reordered).clean).toBe(true);

    const moved = clone(oracle);
    toolAt(moved, "catalog.list-parts").response!.fields[0]!.path = "$.identifier";
    const diff = diffIR(oracle, moved);
    expect(diff.responseFieldDivergences[0]!.missing).toContain("id←$.id");
    expect(diff.responseFieldDivergences[0]!.extra).toContain("id←$.identifier");
  });

  it("(c) a changed collection path fails", () => {
    const actual = clone(oracle);
    toolAt(actual, "catalog.list-parts").response!.collection = "$.data[*]";
    expect(diffIR(oracle, actual).clean).toBe(false);
  });

  it("(d) a flipped required flag fails — DEGRADED versus VIOLATION is the whole point", () => {
    const actual = clone(oracle);
    actual.resources["catalog.Part"]!.find((f) => f.name === "pricePerUnit")!.required = true;
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(false);
    expect(diff.requiredDivergences).toEqual([
      { resource: "catalog.Part", field: "pricePerUnit", expected: false, actual: true },
    ]);
  });

  it("a wrong path is a real divergence, not a match", () => {
    const actual = clone(oracle);
    toolAt(actual, "catalog.list-parts").connector!.rest!.path = "/api/v2/parts";
    const diff = diffIR(oracle, actual);
    expect(diff.missingTools).toHaveLength(1);
    expect(diff.extraTools).toHaveLength(1);
  });
});

describe("the harness — what is deliberately EXCLUDED from the pass criterion", () => {
  it("different ids and descriptions are recorded verbatim and still clean (D-8)", () => {
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.list-parts");
    tool.id = "catalog.get-all-parts";
    tool.description = "Returns parts.";
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(true);
    expect(diff.namingDeltas).toEqual([
      expect.objectContaining({ connector: "GET /api/v1/parts", expectedId: "catalog.list-parts", actualId: "catalog.get-all-parts" }),
    ]);
  });

  it("`ref:` degraded to `identifier` is a NAMED known miss, never a generic failure (R-4)", () => {
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.estimate-part-price");
    tool.input.find((f) => f.name === "partId")!.type = { kind: "scalar", semantic: "identifier" };
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(true);
    expect(diff.knownMisses).toEqual([
      expect.objectContaining({ code: "identity-ref-not-inferred", field: "partId", connector: "GET /api/v1/parts/{partId}/price" }),
    ]);
    expect(formatDiff(diff)).toContain("known miss");
  });

  it("a CDL name plus `rest.query` and a wire-named CDL field are the same request — and are exonerated", () => {
    // The oracle authors `widthCm` + `rest.query: {widthCm: width_cm}`; a spec-derived manifest
    // would call the field `width_cm` and need no remap. Same bytes on the wire.
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.estimate-part-price");
    tool.input.find((f) => f.name === "widthCm")!.name = "width_cm";
    tool.input.find((f) => f.name === "heightCm")!.name = "height_cm";
    delete tool.connector!.rest!.query;
    const diff = diffIR(oracle, actual);
    expect(diff.requestDivergences).toEqual([]);
    expect(diff.clean).toBe(true);
  });

  it("a renamed path placeholder still matches the same endpoint, and says it did", () => {
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.estimate-part-price");
    tool.connector!.rest!.path = "/api/v1/parts/{part_id}/price";
    tool.input.find((f) => f.name === "partId")!.name = "part_id";
    const diff = diffIR(oracle, actual);
    expect(diff.matched.find((m) => m.viaNormalizedPath)).toBeDefined();
    expect(diff.clean).toBe(true);
  });
});

describe("the harness — a request that differs on the wire is NOT exonerated", () => {
  it("a dropped parameter fails, even though every response field still matches", () => {
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.estimate-part-price");
    tool.input = tool.input.filter((f) => f.name !== "heightCm");
    delete tool.connector!.rest!.query!.heightCm;
    const diff = diffIR(oracle, actual);
    expect(diff.responseFieldDivergences).toEqual([]);
    expect(diff.clean).toBe(false);
    expect(diff.requestDivergences[0]!.missing).toEqual(["query:height_cm"]);
  });

  it("a parameter sent under a different wire name fails", () => {
    const actual = clone(oracle);
    toolAt(actual, "catalog.estimate-part-price").connector!.rest!.query!.widthCm = "w";
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(false);
    expect(diff.requestDivergences[0]).toMatchObject({ missing: ["query:width_cm"], extra: ["query:w"] });
  });

  it("a parameter promoted from the query into the URL is a different endpoint, and is reported as one", () => {
    const actual = clone(oracle);
    toolAt(actual, "catalog.estimate-part-price").connector!.rest!.path = "/api/v1/parts/{partId}/price/{widthCm}";
    const diff = diffIR(oracle, actual);
    expect(diff.clean).toBe(false);
    expect(diff.missingTools).toHaveLength(1);
    expect(diff.extraTools).toHaveLength(1);
  });
});

describe("#67 — requestShape mirrors `providers/rest`'s object-form `rest.query` and `onQuery`", () => {
  it("an object-form `rest.query` entry's `name` is the wire name, same as the equivalent string form", () => {
    // `invokeRest`'s `buildQuery` reads `mapped.name` for an object entry. `requestShape` must
    // do the same — not stringify the object into `query:[object Object]`.
    const actual = clone(oracle);
    const tool = toolAt(actual, "catalog.estimate-part-price");
    tool.connector!.rest!.query!.widthCm = { name: "width_cm" };
    const diff = diffIR(oracle, actual);
    expect(diff.requestDivergences, formatDiff(diff)).toEqual([]);
    expect(diff.clean).toBe(true);
  });

  it("`onQuery: true` on a body-carrying method is `query:<wire>`, not `body:<name>` (#63)", () => {
    // Both sides are the SAME body-carrying method (POST) on the SAME endpoint, so the tool join
    // (by connector = method + path) still matches — this isolates the `onQuery` behavior from
    // the tool-join behavior exercised elsewhere in this file.
    const expected = clone(oracle);
    const expTool = toolAt(expected, "catalog.estimate-part-price");
    expTool.connector!.rest!.method = "post";
    expTool.connector!.rest!.query = {
      widthCm: { name: "width_cm", onQuery: true },
      heightCm: { name: "height_cm", onQuery: true },
    };

    // The actual manifest marks both fields `onQuery: true` too — `invokeRest` sends them on the
    // URL even though the method carries a body, so this is the SAME wire request and must be
    // exonerated.
    const actual = clone(expected);
    const diff = diffIR(expected, actual);
    expect(diff.requestDivergences, formatDiff(diff)).toEqual([]);
    expect(diff.clean).toBe(true);

    // A manifest that (wrongly) drops `onQuery` — so the fields fall into the body instead — must
    // still diverge from the `onQuery`-correct oracle's query-string request.
    const wrongActual = clone(expected);
    delete toolAt(wrongActual, "catalog.estimate-part-price").connector!.rest!.query;
    const wrongDiff = diffIR(expected, wrongActual);
    expect(wrongDiff.clean).toBe(false);
    expect(wrongDiff.requestDivergences[0]!.missing).toEqual(["query:height_cm", "query:width_cm"]);
    expect(wrongDiff.requestDivergences[0]!.extra).toEqual(["body:heightCm", "body:widthCm"]);
  });
});

describe("NF-3 — known misses join by the connector, never by the CDL field name", () => {
  // This file's own header says the id is the axis the pass criterion EXCLUDES and therefore
  // cannot also be the join key. That argument applies one level down and was not applied
  // there: known misses joined by `field.name`, so a generated manifest that named the path
  // parameter differently from the oracle found no counterpart, `continue` fired, and R-4 —
  // the increment's HEADLINE known miss, likelihood "H (certain)" — reported as zero.
  //
  // Measured on the real oracle before the fix: `known misses = 0`, because the hand-written
  // manifest calls the parameter `frameProfileId` and a spec-derived one calls it `id`. A
  // known miss that cannot appear is worse than one that appears too often, because DoD-3(a)
  // promises this one "appears as a named known miss".

  /** The oracle, with its `ref:` path parameter renamed and degraded to a scalar identifier —
   *  exactly what an adapter produces, since no source construct implies the link. */
  function generatedLikeness(): IR {
    const ir = clone(oracle);
    const tool = toolAt(ir, "catalog.estimate-part-price");
    const rest = tool.connector!.rest!;
    rest.path = rest.path.replace("{partId}", "{id}");
    tool.input = tool.input.map((f) =>
      f.name === "partId" ? { ...f, name: "id", type: { kind: "scalar" as const, semantic: "identifier" as const } } : f,
    );
    return ir;
  }

  it("finds the degradation even when the two manifests name the path parameter differently", () => {
    const diff = diffIR(oracle, generatedLikeness());
    expect(diff.knownMisses).toEqual([
      expect.objectContaining({ code: "identity-ref-not-inferred", field: "partId" }),
    ]);
  });

  it("the tools still match, and the rename is not counted as a failure", () => {
    // The rename is a naming difference, which the criterion excludes — so it must show up as
    // a normalized-path match, not as one missing and one extra tool.
    const diff = diffIR(oracle, generatedLikeness());
    expect(diff.missingTools).toEqual([]);
    expect(diff.extraTools).toEqual([]);
    expect(diff.matched.some((m) => m.viaNormalizedPath)).toBe(true);
    expect(diff.requestDivergences, formatDiff(diff)).toEqual([]);
  });

  it("a query/body field still joins by name, which is its wire identity", () => {
    // The fallback must not be lost: `requestShape` already establishes that non-path fields
    // keep their wire identity, so the name is the right key for them.
    const ir = clone(oracle);
    const tool = toolAt(ir, "catalog.estimate-part-price");
    tool.input = tool.input.map((f) => (f.name === "partId" ? { ...f, type: { kind: "scalar" as const, semantic: "identifier" as const } } : f));
    const diff = diffIR(oracle, ir);
    expect(diff.knownMisses).toHaveLength(1);
  });
});
