import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { diffIR, emit, formatDiff, openApiAdapter, type DecisionRecord, type IRDiff } from "@archstone/init";
import { commitFileSet, compileForDiff } from "@archstone/init/loop";

// THE SECOND ORACLE — a real inference-quality measurement that costs nothing.
//
// `oracle.test.ts` is honest about what it measures: its Draft Model is hand-written by someone
// who had read the expected manifest, so it measures EMISSION FIDELITY. Inference quality needs
// a source nobody authored for the purpose, and until now the only one was a design partner's
// live contract — out of tree by #35, so the measurement was a one-off reported in prose.
//
// This one is in-tree and permanent. `examples/demo/stays-openapi.yaml` describes
// `examples/demo/mock-stays-server.mjs`, the demo's own backend; `examples/manifests/tourism/`
// is the hand-written manifest that backend is bound to, predating this increment, and the
// shape ADD-37 calls canonical. The spec was written from the SERVER's source, not from the
// manifest — the same structural non-contamination argument O-14 makes for ArtVinci's document.
//
// IT COULD NOT HAVE EXISTED BEFORE THIS FIX. `tourism.search` is a `POST /v1/search` whose only
// input is a request-body property. Run through the adapter as shipped, it produced a capability
// with no `input:` at all — so the measurement below was not merely failing, it was unavailable.
//
// AND IT IS NOT CLEAN, deliberately. Three divergences survive, each recorded with its cause
// below. Tuning the fixture until they vanished would have meant writing the manifest's answers
// into the spec, which is the one thing that would make this stop being an oracle.

const here = dirname(fileURLToPath(import.meta.url));
// Beside the server it describes, not in test fixtures: it is also what the README and the
// launch GIF point a reader at, and "try init on our test fixture" reads badly in both.
const DEMO_SPEC = resolve(here, "../../../examples/demo/stays-openapi.yaml");
const TOURISM = resolve(here, "../../../examples/manifests/tourism");

const DECISIONS: DecisionRecord = {
  // Everything a human must decide, decided by a human: the company, the provider, the
  // capability id and the effect. DoD-3 excludes naming from the pass criterion for exactly
  // this reason — no spec construct carries a domain.
  version: "0",
  company: { id: "wanderlust", name: "Wanderlust Travel" },
  provider: "booking-engine",
  decisions: [{ operation: "POST /v1/search", keep: true, capabilityId: "tourism.search", effect: "read" }],
};

describe("the second oracle: a spec of the demo's own backend vs. the hand-written manifest", () => {
  let workspace: string;
  let diff: IRDiff;
  let files: ReadonlyMap<string, string>;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "archstone-second-oracle-"));
    const draft = openApiAdapter.adapt({ origin: "stays-openapi.yaml", document: readFileSync(DEMO_SPEC, "utf8") });
    const emitted = emit(draft, DECISIONS);
    files = emitted.files;
    const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
    expect(committed.failures, "the generated manifest must compile").toEqual([]);
    diff = diffIR(compileForDiff(TOURISM), committed.ir!);
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("DoD-3(a) — one tool, matched by connector, nothing missing and nothing extra", () => {
    expect(diff.matched.map((m) => m.connector)).toEqual(["POST /v1/search"]);
    expect(diff.missingTools, formatDiff(diff)).toEqual([]);
    expect(diff.extraTools, formatDiff(diff)).toEqual([]);
  });

  it("DoD-3(b) — `effect` agrees, because a human confirmed it", () => {
    // A `POST /search` is `read` (Axiom A-1), and no method-based heuristic could have said so.
    expect(diff.effectDivergences, formatDiff(diff)).toEqual([]);
  });

  it("DoD-3(c) — every JSONPath the human wrote is reproduced, including the collection", () => {
    // The measurement this fix exists to make possible. `missing: []` is the claim: the four
    // fields the hand-written binding maps, and the `$.stays[*]` collection, come out
    // byte-identical from a document nobody wrote for the purpose.
    const [response] = diff.responseFieldDivergences;
    expect(response?.missing ?? [], formatDiff(diff)).toEqual([]);
    // The one extra is `id`, which the server genuinely returns (`buildStays` sets it on every
    // element) and which the human chose not to expose. That is a product decision, not an
    // inference error — the same class as M-1's declined operations.
    expect(response?.extra ?? []).toEqual(["id←$.id"]);
  });

  it("DoD-3(d) — required flags agree except where only a human could know", () => {
    // `name`, `location` and `pricePerNight` classify required on both sides, from the spec's
    // `required[]` plus D-12's positive evidence of non-nullability. Not vacuous: they are a
    // real 3/4 over a non-empty intersection.
    expect(diff.requiredDivergences.map((d) => d.field)).toEqual(["rating"]);
    // `rating` is the honest miss. The mock constructs it on every element unconditionally, so
    // any faithful description of that backend says it is always present; the human wrote
    // "when available", which is a fact about the real world no spec of this server could
    // settle. Exactly R-9's shape: a mapping that is structurally right and semantically
    // narrower than a human's judgement.
    expect(diff.requiredDivergences[0]).toMatchObject({ resource: "tourism.Stay", field: "rating", expected: false, actual: true });
  });

  it("the request is missing the three inputs the mock backend does not read", () => {
    // `destination` — the body property this whole change is about — is present, and it is the
    // only one the server reads (`query?.destination`). `dates`, `travelers` and `budget` are in
    // the hand-written capability because the human knows the business, not because the backend
    // does anything with them. Declaring them in the spec to close this gap would have been
    // writing the expected answer into the input.
    const [request] = diff.requestDivergences;
    expect(request?.missing ?? []).toEqual(["body:budget", "body:dates", "body:travelers"]);
    expect(request?.extra ?? []).toEqual([]);
  });

  it("the body property reaches the binding as capability input, with no invented `rest.body`", () => {
    const capability = files.get("tourism.search.capability.yaml")!;
    // No `required: false` line means required — the CDL default, and what the hand-written
    // capability says for `destination` too.
    expect(capability).toMatch(/^ {4}destination:$/m);
    expect(capability).not.toMatch(/destination:[\s\S]*?required: false/);

    const binding = files.get("bindings/tourism.search.binding.yaml")!;
    expect(binding).toMatch(/method: POST/);
    expect(binding).toMatch(/collection: "\$\.stays\[\*\]"/);
    // `invokeRest` serializes the capability input as the JSON body for any non-GET method,
    // keyed by the CDL field name — which is precisely what the hand-written binding relies on.
    // It carries no `rest.body`, and neither may this.
    expect(binding).not.toMatch(/^\s+body:/m);
  });

  it("the semantic-type gap is real, measured, and outside what the diff scores", () => {
    // Worth pinning because DoD-3(c) compares {name, path} pairs and would never show it: the
    // human typed `location`, `text` and `quantity`; a bare `type: string` implies none of them.
    // This is product D-4's "only you know" case, and it is the honest ceiling on what any
    // document-driven inference reaches.
    const resource = files.get("tourism.Stay.resource.yaml")!;
    expect(resource).toMatch(/location:\n\s+type: string/);
    const handWritten = readFileSync(resolve(TOURISM, "tourism.Stay.resource.yaml"), "utf8");
    expect(handWritten).toMatch(/location:\n\s+type: location/);
  });
});
