import { describe, it, expect } from "vitest";
import { absent, declared, note, type DraftModel, type SourceAdapter, type SourceInput } from "@archstone/init";
import { assertAdapterConformance } from "./conformance";
import { arrayOf, objectNode, operation, property, scalarNode } from "./draft";

// ADD-37 §6 step 1 defines the input boundary; step 5 ships the first adapter, and is
// deliberately NOT in this increment — the adapter choice is blocked on a question about a
// design partner's backend, and picking one early is precisely the bet the boundary exists to
// avoid making.
//
// So the adapter below is NOT an adapter. It reads nothing and infers nothing: it returns a
// fixed Draft Model, plus a note when it was handed an input it has no use for. Its only job is
// to prove that the interface is implementable and that the conformance suite is exercisable,
// so that step 5's real adapter has a contract to be measured against on day one rather than a
// contract invented to fit whatever it happened to do.

const FIXED_OPERATION = operation("GET", "/api/v1/parts", {
  description: "List parts.",
  response: objectNode([
    property("items", arrayOf(objectNode([property("id", scalarNode({ type: "identifier", example: "P-1" }), { declaredRequired: true })], { name: "Part" }))),
  ]),
});

const stubAdapter: SourceAdapter = {
  id: "stub",
  summary: "A test double: returns a fixed Draft Model and reads nothing.",
  adapt(input: SourceInput): DraftModel {
    const notes = input.document === undefined && (input.observations ?? []).length === 0
      ? [note("unsupported-operation-shape", "manifest", input.origin, "this adapter was handed neither a document nor an observation")]
      : [];
    return {
      version: "0",
      source: { adapter: "stub", origin: input.origin },
      company: { id: absent<string>(), name: absent<string>(), description: absent<string>() },
      baseUrl: declared("https://api.example.test"),
      operations: [{ ...FIXED_OPERATION, effectHint: { value: "read", derivation: "heuristic", rationale: "the method is GET" } }],
      notes,
    };
  },
};

describe("SourceAdapter — the input boundary is implementable and checkable", () => {
  it("a conforming adapter passes the suite", () => {
    assertAdapterConformance(stubAdapter, [
      { origin: "./spec.yaml", document: "anything" },
      { origin: "a recorded call", observations: [{ method: "GET", path: "/api/v1/parts", response: { items: [] } }] },
    ]);
  });

  it("the suite catches an adapter that mislabels its own output", () => {
    const liar: SourceAdapter = { ...stubAdapter, id: "liar" };
    expect(() => assertAdapterConformance(liar, [{ origin: "x", document: "y" }])).toThrow();
  });

  it("the suite catches a non-deterministic adapter — the property CI depends on", () => {
    let n = 0;
    const flaky: SourceAdapter = {
      ...stubAdapter,
      adapt(input) {
        const draft = stubAdapter.adapt(input);
        return { ...draft, baseUrl: declared(`https://api-${n++}.example.test`) };
      },
    };
    expect(() => assertAdapterConformance(flaky, [{ origin: "x", document: "y" }])).toThrow();
  });

  it("an effect HINT never becomes an effect: it carries its own `heuristic` label, and emission cannot read it", () => {
    const draft = stubAdapter.adapt({ origin: "x", document: "y" });
    expect(draft.operations[0]!.effectHint).toEqual({ value: "read", derivation: "heuristic", rationale: "the method is GET" });
    // The emitter's signature takes the Decision Record, not the draft's hint — there is no
    // code path from this object to an emitted `effect:`. See emit.test.ts for the positive
    // statement (the emitted value is the confirmed one).
  });
});
