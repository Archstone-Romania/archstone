import { describe, it, expect } from "vitest";
import { classifyRequired, locusCandidates, locusLeaves, propertyAccessor, selectLocus } from "@archstone/init";
import type { DraftNode } from "@archstone/init";
import { arrayOf, objectNode, property, scalarNode } from "./draft";

// ADD-37 §1.1 (D-9) and §1.2, branch by branch. These two rules are where a mistake is
// cheapest to make and most expensive to discover — §1.2's especially, because getting it
// backwards ships a manifest that compiles, verifies green, and VIOLATES on the first real
// null.

/** Census + selection in one call, for the cases where no human answer is involved. */
function resolve(response: DraftNode, responseLocus?: string) {
  return selectLocus(locusCandidates(response), responseLocus);
}

describe("D-14 — the locus census enumerates, and never prefers", () => {
  it("a bare array of objects yields ONE candidate, so no question is ever asked", () => {
    const selection = resolve(arrayOf(objectNode([property("name", scalarNode({ type: "text" }))])));
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.sole).toBe(true);
    expect(selection.candidate.collection).toBe("$[*]");
    expect(selection.candidate.property).toBeUndefined();
  });

  it("an object with a list AND scalar siblings yields TWO candidates — the overlap D-14 exists for", () => {
    // O-21: `{items[], total, page, limit}` (a paginated list) and `{warnings[], quotedPrice,
    // currency}` (a payload with diagnostics) are STRUCTURALLY IDENTICAL. The old branch order
    // picked the array in both, which shipped a price capability returning warnings.
    const census = locusCandidates(
      objectNode([
        property("items", arrayOf(objectNode([property("name", scalarNode({ type: "text" }))]))),
        property("total", scalarNode({ type: "quantity" })),
      ]),
    );
    expect(census.candidates.map((c) => c.id)).toEqual(["root", "$.items[*]"]);
    // The census carries FIELD NAMES, not just paths — R-11's mitigation lives entirely in the
    // gate's wording, and "a list of X or one X with a list inside it?" is unanswerable from
    // two JSONPaths alone.
    expect(census.candidates.find((c) => c.id === "root")!.fields).toEqual(["total"]);
    expect(census.candidates.find((c) => c.id === "$.items[*]")!.fields).toEqual(["name"]);
  });

  it("two candidates with no answer is a REFUSAL, never a pick", () => {
    const selection = resolve(
      objectNode([
        property("items", arrayOf(objectNode([property("name", scalarNode({ type: "text" }))]))),
        property("total", scalarNode({ type: "quantity" })),
      ]),
    );
    expect(selection.kind).toBe("ambiguous");
  });

  it("the Decision Record's answer selects, and the emitter can only see the selection", () => {
    const response = objectNode([
      property("warnings", arrayOf(objectNode([property("code", scalarNode({ type: "string" }))]))),
      property("quotedPrice", scalarNode({ type: "quantity" })),
    ]);
    const asRoot = resolve(response, "root");
    expect(asRoot.kind === "selected" && asRoot.candidate.kind).toBe("root");
    const asList = resolve(response, "$.warnings[*]");
    expect(asList.kind === "selected" && asList.candidate.collection).toBe("$.warnings[*]");
  });

  it("an answer that matches no candidate REFUSES — it never falls back to the pre-fill", () => {
    // A Decision Record written against a document that has since changed must refuse, exactly
    // as `unknown-candidate` does one level up, rather than silently answer a different
    // question than the one the human agreed to.
    const selection = resolve(
      objectNode([
        property("items", arrayOf(objectNode([property("name", scalarNode({ type: "text" }))]))),
        property("total", scalarNode({ type: "quantity" })),
      ]),
      "$.results[*]",
    );
    expect(selection.kind).toBe("ambiguous");
    expect(selection.kind === "ambiguous" && selection.supplied).toBe("$.results[*]");
  });

  it("two or more collections and no scalar root is still ambiguous — unchanged from before", () => {
    const twoLists = objectNode([
      property("parts", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))]))),
      property("kits", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))]))),
    ]);
    expect(locusCandidates(twoLists).candidates.map((c) => c.id)).toEqual(["$.parts[*]", "$.kits[*]"]);
    expect(resolve(twoLists).kind).toBe("ambiguous");
  });

  it("an object with only scalars yields ONE candidate — the root, with no question", () => {
    const selection = resolve(
      objectNode([property("estimatedPrice", scalarNode({ type: "quantity" })), property("currency", scalarNode({ type: "string" }))]),
    );
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.sole).toBe(true);
    expect(selection.candidate.kind).toBe("root");
  });

  it("an array of SCALARS has no candidate — no resource, no output, no response", () => {
    expect(resolve(arrayOf(scalarNode({ type: "string" }))).kind).toBe("none");
  });

  it("a bare scalar has no candidate", () => {
    expect(resolve(scalarNode({ type: "string" })).kind).toBe("none");
  });

  it("an object of nothing but nested objects has no candidate (an empty `map:` is not shape-valid)", () => {
    expect(resolve(objectNode([property("details", objectNode([property("a", scalarNode({ type: "string" }))]))])).kind).toBe("none");
  });

  it("an undescribable shape carries whatever paths were observed, as a hint for the human", () => {
    const census = locusCandidates({ kind: "unknown", observedPaths: ["$.a", "$.b"] });
    expect(census.candidates).toEqual([]);
    expect(census.observedPaths).toEqual(["$.a", "$.b"]);
  });

  it("a collection under an unaddressable property name is reported, not silently dropped", () => {
    const census = locusCandidates(
      objectNode([property("it[e]ms", arrayOf(objectNode([property("a", scalarNode({ type: "string" }))])))]),
    );
    expect(census.candidates).toEqual([]);
    expect(census.unaddressable).toEqual(["it[e]ms"]);
  });
});

describe("D-9 step 2 — depth: scalar leaves at depth ≤ 1 only", () => {
  it("maps scalars and reports nested properties as unmapped, never flattening or promoting them", () => {
    const locus = objectNode([
      property("name", scalarNode({ type: "text" })),
      property("dimensions", objectNode([property("widthMm", scalarNode({ type: "quantity" }))])),
      property("tags", arrayOf(scalarNode({ type: "string" }))),
    ]);
    const { leaves, nested } = locusLeaves(locus);
    expect(leaves.map((l) => [l.property.name, l.path])).toEqual([["name", "$.name"]]);
    expect(nested.map((p) => p.name)).toEqual(["dimensions", "tags"]);
  });
});

describe("§1.2 — required = declared-required AND NOT nullable AND (if probed) always present", () => {
  it("declared required and not nullable ⇒ required", () => {
    const result = classifyRequired(property("name", scalarNode({ type: "text", nullable: false }), { declaredRequired: true }));
    expect(result.required).toBe(true);
    expect(result.basis.kind).toBe("declared");
  });

  it("declared required BUT nullable ⇒ OPTIONAL — a null maps like a missing value, so required would VIOLATE", () => {
    const result = classifyRequired(property("price", scalarNode({ type: "quantity", nullable: true }), { declaredRequired: true }));
    expect(result.required).toBe(false);
  });

  it("declared required but absent in one observed item ⇒ optional", () => {
    const result = classifyRequired(
      property("name", scalarNode({ type: "text", nullable: false }), { declaredRequired: true, presence: { items: 5, presentNonNull: 4 } }),
    );
    expect(result.required).toBe(false);
  });

  it("declared optional stays optional however often it was observed", () => {
    const result = classifyRequired(
      property("color", scalarNode({ type: "string" }), { declaredRequired: false, presence: { items: 9, presentNonNull: 9 } }),
    );
    expect(result.required).toBe(false);
  });

  it("observation only: present and non-null in EVERY item ⇒ required, and the sample size is recorded", () => {
    const result = classifyRequired(property("id", scalarNode({ type: "identifier" }), { presence: { items: 12, presentNonNull: 12 } }));
    expect(result.required).toBe(true);
    expect(result.basis).toEqual({ kind: "observational", items: 12, presentNonNull: 12 });
  });

  it("observation only: missing in ONE item ⇒ optional", () => {
    const result = classifyRequired(property("id", scalarNode({ type: "identifier" }), { presence: { items: 12, presentNonNull: 11 } }));
    expect(result.required).toBe(false);
  });

  it("observation of ZERO items is not evidence of anything", () => {
    const result = classifyRequired(property("id", scalarNode({ type: "identifier" }), { presence: { items: 0, presentNonNull: 0 } }));
    expect(result.required).toBe(false);
  });

  it("nothing known at all ⇒ optional, so a missing value DEGRADES instead of VIOLATING", () => {
    const result = classifyRequired(property("mystery", scalarNode({})));
    expect(result).toEqual({ required: false, basis: { kind: "unknown" } });
  });
});

describe("D-9 — a property name is only mapped when a JSONPath can address it", () => {
  it("uses dot notation for a simple name and bracket notation for anything else", () => {
    expect(propertyAccessor("name")).toBe(".name");
    expect(propertyAccessor("price.usd")).toBe("['price.usd']");
    expect(propertyAccessor("a b")).toBe("['a b']");
    expect(propertyAccessor("x-y")).toBe("['x-y']");
    expect(propertyAccessor("0")).toBe("['0']");
  });

  it("declines a name no JSONPath can carry, rather than emitting one that resolves to nothing", () => {
    // `jsonpath-plus` does not honour a backslash escape inside `$['…']`, so these have no
    // expressible form at all. Checked against the real evaluator — see the reason code's docs.
    expect(propertyAccessor("it's")).toBeUndefined();
    expect(propertyAccessor("back\\slash")).toBeUndefined();
    expect(propertyAccessor("we[i]rd")).toBeUndefined();
  });

  it("a leaf with an unaddressable name is separated from the mapped ones, never dropped silently", () => {
    const { leaves, unaddressable } = locusLeaves(
      objectNode([property("price.usd", scalarNode({ type: "quantity" })), property("it's", scalarNode({ type: "string" }))]),
    );
    expect(leaves.map((l) => l.path)).toEqual(["$['price.usd']"]);
    expect(unaddressable.map((p) => p.name)).toEqual(["it's"]);
  });

  it("a collection under an unaddressable property is not a candidate at all", () => {
    const census = locusCandidates(
      objectNode([property("it's", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))])))]),
    );
    expect(census.candidates).toEqual([]);
    expect(census.unaddressable).toEqual(["it's"]);
  });
});
