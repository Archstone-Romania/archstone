import { describe, it, expect } from "vitest";
import { emit, type DecisionRecord } from "@archstone/init";
import { evalPath } from "@archstone/compiler";
import { arrayOf, draftModel, inputField, objectNode, operation, property, scalarNode } from "./draft";

// ADD-37 §6 step 2. Emission is pure, so every branch is reachable from a hand-built Draft
// Model with no adapter, no temp dir and no backend.

const listOperation = operation("GET", "/api/v1/parts", {
  description: "List parts.",
  response: objectNode([
    property(
      "items",
      arrayOf(
        objectNode(
          [
            // D-12: `required: true` demands POSITIVE evidence of non-nullability, so a
            // Draft Model that means "this is never null" must say so. An adapter that leaves
            // `nullable` absent everywhere makes every field optional — visibly, in DoD-3(d).
            property("id", scalarNode({ type: "identifier", nullable: false, source: "Part.id", example: "P-1" }), { declaredRequired: true }),
            property("name", scalarNode({ type: "text", nullable: false, source: "Part.name", example: "Bracket" }), { declaredRequired: true }),
            property("color", scalarNode({ type: "string", nullable: true }), { declaredRequired: true }),
          ],
          { name: "Part", description: "A part Acme can supply." },
        ),
      ),
    ),
  ]),
});

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    version: "0",
    company: { id: "acme", name: "Acme Parts" },
    decisions: [{ operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" }],
    ...overrides,
  };
}

describe("emission — the file set", () => {
  it("emits capabilities.yaml, one capability, one resource and one binding", () => {
    const result = emit(draftModel([listOperation]), record());
    expect([...result.files.keys()].sort()).toEqual([
      "bindings/catalog.list-parts.binding.yaml",
      "capabilities.yaml",
      "catalog.Part.resource.yaml",
      "catalog.list-parts.capability.yaml",
    ]);
  });

  it("is deterministic — the same input produces byte-identical output", () => {
    const first = emit(draftModel([listOperation]), record());
    const second = emit(draftModel([listOperation]), record());
    expect([...second.files.entries()]).toEqual([...first.files.entries()]);
  });

  it("takes `effect` from the Decision Record, and the resource name from the human when supplied", () => {
    const result = emit(
      draftModel([listOperation]),
      record({
        decisions: [
          { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", resourceName: "Component" },
        ],
      }),
    );
    expect(result.files.has("catalog.Component.resource.yaml")).toBe(true);
    expect(result.capabilities[0]!.effect).toBe("read");
  });

  it("names the resource from the collection property when the source declared no component name", () => {
    const anonymous = operation("GET", "/api/v1/parts", {
      response: objectNode([property("parts", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))])))]),
    });
    const result = emit(draftModel([anonymous]), record());
    expect(result.files.has("catalog.Part.resource.yaml")).toBe(true);
  });

  it("refuses the candidate when no resource name is derivable and none was supplied", () => {
    const anonymous = operation("GET", "/api/v1/parts", {
      response: objectNode([property("items", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))])))]),
    });
    // `items` singularizes to `Item`, which IS grammar-valid — so to reach the refusal the
    // property has to be one that yields no legal name at all.
    const unnameable = operation("GET", "/api/v1/parts", {
      response: objectNode([property("123", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))])))]),
    });
    expect(emit(draftModel([anonymous]), record()).files.has("catalog.Item.resource.yaml")).toBe(true);

    const refused = emit(draftModel([unnameable]), record());
    expect(refused.files.size).toBe(0);
    expect(refused.skipped.map((s) => s.code)).toEqual(["resource-name-not-derivable"]);
  });
});

describe("emission — the three keys that are NEVER written (Challenge 2)", () => {
  const emitted = emit(draftModel([listOperation]), record());
  const capability = emitted.files.get("catalog.list-parts.capability.yaml")!;
  const binding = emitted.files.get("bindings/catalog.list-parts.binding.yaml")!;

  it("emits no `lifecycle:` — `experimental` is hidden from tools/list, so `serve` would show an empty tool list", () => {
    expect(capability).not.toMatch(/^\s*lifecycle:/m);
  });

  it("emits no `policies:` — `authenticated` gates callTool, executeCapability AND verifyTool, and the CLI has no caller-injection surface", () => {
    expect(capability).not.toMatch(/^\s*policies:/m);
  });

  it("emits no `failures:` — a 4xx's business meaning is not derivable, and the keys would be invented prose", () => {
    expect(capability).not.toMatch(/^\s*failures:/m);
  });

  it("emits no `contract:` — it is all-or-nothing and requires a recorded response", () => {
    expect(binding).not.toMatch(/^\s*contract:/m);
    expect(binding).not.toMatch(/fingerprint/);
  });

  it("says out loud that no contract was recorded, rather than leaving it as an omission", () => {
    expect(emitted.notes.some((n) => n.code === "contract-not-recorded")).toBe(true);
  });

  it("surfaces a declared auth scheme as a header placeholder, never as a policy", () => {
    const withAuth = emit(
      draftModel([listOperation], { auth: { headerName: "authorization", valuePrefix: "Bearer ", scheme: "bearer" } }),
      record(),
    );
    const bound = withAuth.files.get("bindings/catalog.list-parts.binding.yaml")!;
    // Amendment 1 §A-5 gap 2: the value is a TEMPLATE, not a bare placeholder. A `bearer`
    // scheme's wire value is `Bearer <token>`, and writing `${VAR}` alone is silently wrong at
    // the first real call.
    expect(bound).toMatch(/authorization: "Bearer \$\{ACME_API_TOKEN\}"/);
    expect(withAuth.files.get("catalog.list-parts.capability.yaml")!).not.toMatch(/policies/);
    expect(withAuth.notes.some((n) => n.code === "security-scheme-not-a-policy")).toBe(true);
  });

  it("an `apiKey, in: header` scheme carries no prefix", () => {
    const withAuth = emit(
      draftModel([listOperation], { auth: { headerName: "x-api-key", valuePrefix: "", scheme: "apiKey" } }),
      record(),
    );
    expect(withAuth.files.get("bindings/catalog.list-parts.binding.yaml")!).toMatch(/x-api-key: "\$\{ACME_API_TOKEN\}"/);
  });

  it("an operation the source declares public overrides a manifest-level default (§A-5 gap 1)", () => {
    // Not cosmetic: an `${ENV}` placeholder whose variable is unset makes `invokeRest` fail
    // with `missing env var(s)` BEFORE any network call, so a manifest-level header written
    // into a public endpoint's binding makes that capability un-invocable until the user sets
    // a token they do not need.
    const publicOp = { ...listOperation, auth: { kind: "none" } as const };
    const withAuth = emit(
      draftModel([publicOp], { auth: { headerName: "authorization", valuePrefix: "Bearer ", scheme: "bearer" } }),
      record(),
    );
    const bound = withAuth.files.get("bindings/catalog.list-parts.binding.yaml")!;
    expect(bound).not.toMatch(/headers:/);
    expect(bound).not.toMatch(/authorization/);
    expect(withAuth.notes.some((n) => n.code === "security-scheme-not-a-policy")).toBe(false);
  });

  it("an operation-scoped scheme beats the manifest default", () => {
    const adminOp = { ...listOperation, auth: { kind: "header", headerName: "x-admin-key", valuePrefix: "" } as const };
    const withAuth = emit(draftModel([adminOp]), record({ authEnvVar: "ACME_ADMIN_TOKEN" }));
    expect(withAuth.files.get("bindings/catalog.list-parts.binding.yaml")!).toMatch(/x-admin-key: "\$\{ACME_ADMIN_TOKEN\}"/);
  });
});

describe("emission — D-9's branches, at the file level", () => {
  it("a single object at the response root: no `collection`, output typed by the resource", () => {
    const single = operation("GET", "/api/v1/parts/{partId}/price", {
      input: [inputField("partId", "path", { type: "identifier" })],
      response: objectNode(
        [
          property("estimatedPrice", scalarNode({ type: "quantity", nullable: true }), { declaredRequired: true }),
          property("currency", scalarNode({ type: "string" }), { declaredRequired: true }),
        ],
        { name: "PartPriceEstimate" },
      ),
    });
    const result = emit(
      draftModel([single]),
      record({
        decisions: [
          { operation: "GET /api/v1/parts/{partId}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
        ],
      }),
    );
    const binding = result.files.get("bindings/catalog.estimate-part-price.binding.yaml")!;
    expect(binding).not.toMatch(/^\s*collection:/m);
    expect(result.files.get("catalog.estimate-part-price.capability.yaml")).toMatch(/type: catalog\.PartPriceEstimate/);
  });

  it("ambiguous collection: the operation is skipped and NOTHING is emitted for it", () => {
    const ambiguous = operation("GET", "/api/v1/parts", {
      response: objectNode([
        property("parts", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))]))),
        property("kits", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))]))),
      ]),
    });
    const result = emit(draftModel([ambiguous]), record());
    expect(result.files.size).toBe(0); // the only candidate was skipped ⇒ empty confirmed set
    expect(result.skipped[0]!.code).toBe("ambiguous-collection");
  });

  it("a nested property is reported as unmapped — never flattened, never a second resource", () => {
    const nested = operation("GET", "/api/v1/parts", {
      response: objectNode([
        property(
          "items",
          arrayOf(
            objectNode(
              [property("id", scalarNode({ type: "identifier" })), property("dimensions", objectNode([property("widthMm", scalarNode({ type: "quantity" }))]))],
              { name: "Part" },
            ),
          ),
        ),
      ]),
    });
    const result = emit(draftModel([nested]), record());
    expect(result.notes.some((n) => n.code === "nested-object-not-mapped" && n.target === "catalog.list-parts#dimensions")).toBe(true);
    expect(result.files.get("catalog.Part.resource.yaml")).not.toMatch(/dimensions/);
    expect([...result.files.keys()].filter((k) => k.endsWith(".resource.yaml"))).toHaveLength(1);
  });

  it("no usable response shape: a compiling capability with a connector, no resource, no output, no response", () => {
    const opaque = operation("GET", "/api/v1/health", { response: { kind: "unknown", observedPaths: ["$.status"] } });
    const result = emit(
      draftModel([opaque]),
      record({ decisions: [{ operation: "GET /api/v1/health", keep: true, capabilityId: "catalog.health", effect: "read" }] }),
    );
    expect([...result.files.keys()].some((k) => k.endsWith(".resource.yaml"))).toBe(false);
    expect(result.files.get("catalog.health.capability.yaml")).not.toMatch(/^\s*output:/m);
    expect(result.files.get("bindings/catalog.health.binding.yaml")).not.toMatch(/^\s*response:/m);
    const note = result.notes.find((n) => n.code === "no-response-shape");
    expect(note?.detail).toContain("$.status");
  });
});

describe("emission — required/optional reaches the YAML (§1.2)", () => {
  it("writes `required: false` for a declared-required-but-nullable field, and leaves required implicit", () => {
    const resource = emit(draftModel([listOperation]), record()).files.get("catalog.Part.resource.yaml")!;
    expect(resource).toMatch(/id:\n\s+type: identifier\n\s+description|id:\n\s+type: identifier/);
    // `color` is declared required but nullable ⇒ optional here, or the first real null VIOLATES.
    expect(resource).toMatch(/color:\n\s+type: string\n\s+required: false/);
    // `name` is declared required and declared NOT nullable ⇒ the CDL default (true), implicit.
    expect(resource).not.toMatch(/name:\n\s+type: text\n\s+required:/);
  });

  it("D-12: declared-required with UNKNOWN nullability is optional, and says why", () => {
    // The case §1.2's box could not see and the shipped `classifyRequired` collapsed into
    // known-false. It matters exactly where an adapter could not determine nullability — an
    // unresolved `$ref`, an unreduced `oneOf`, a composition conflict — and O-6 makes
    // "assume non-null" the direction that ships a VIOLATION the first time the backend
    // tells the truth.
    const unknownNullability = operation("GET", "/api/v1/parts", {
      response: arrayOf(
        objectNode([property("sku", scalarNode({ type: "string" }), { declaredRequired: true })], { name: "Part" }),
      ),
    });
    const resource = emit(draftModel([unknownNullability]), record()).files.get("catalog.Part.resource.yaml")!;
    expect(resource).toMatch(/sku:\n\s+type: string\n\s+required: false/);
    expect(resource).toMatch(/never established non-nullability/);
  });

  it("records observational classification with its sample size — a measurement, not a claim", () => {
    const observedOp = operation("GET", "/api/v1/parts", {
      response: arrayOf(
        objectNode([property("id", scalarNode({ type: "identifier" }), { presence: { items: 7, presentNonNull: 7 } })], { name: "Part" }),
      ),
    });
    const result = emit(draftModel([observedOp]), record());
    const note = result.notes.find((n) => n.code === "required-classification-observational");
    expect(note?.detail).toBe("from 7 observed item(s)");
    expect(result.files.get("catalog.Part.resource.yaml")).toMatch(/classified from 7 observed item/);
  });
});

describe("emission — legibility (product §5) and the known miss (R-4)", () => {
  it("every mapped line carries its source field and an observed example, rendered from provenance", () => {
    const binding = emit(draftModel([listOperation]), record()).files.get("bindings/catalog.list-parts.binding.yaml")!;
    expect(binding).toMatch(/name: "\$\.name"\s+# declared Part\.name — e\.g\. "Bracket"/);
  });

  it("an `identifier` input is reported as a possible `ref:` — the increment's headline known miss", () => {
    const detail = operation("GET", "/api/v1/parts/{partId}", {
      input: [inputField("partId", "path", { type: "identifier" })],
      response: objectNode([property("id", scalarNode({ type: "identifier" }))], { name: "Part" }),
    });
    const result = emit(
      draftModel([detail]),
      record({ decisions: [{ operation: "GET /api/v1/parts/{partId}", keep: true, capabilityId: "catalog.get-part", effect: "read" }] }),
    );
    expect(result.notes.some((n) => n.code === "identity-ref-not-inferred" && n.target === "catalog.get-part#partId")).toBe(true);
  });

  it("a field with no derivable semantic type degrades to `string` and says so per field", () => {
    const vague = operation("GET", "/api/v1/parts", {
      response: arrayOf(objectNode([property("where", scalarNode({}))], { name: "Part" })),
    });
    const result = emit(draftModel([vague]), record());
    expect(result.notes.some((n) => n.code === "semantic-type-degraded" && n.target === "catalog.list-parts#where")).toBe(true);
    expect(result.files.get("catalog.Part.resource.yaml")).toMatch(/where:\n\s+type: string/);
  });

  it("a wire-name difference becomes `rest.query`, so the CDL keeps the business name", () => {
    const sized = operation("GET", "/api/v1/parts/{partId}/price", {
      input: [inputField("partId", "path", { type: "identifier" }), inputField("widthCm", "query", { type: "quantity", wireName: "width_cm" })],
      response: objectNode([property("currency", scalarNode({ type: "string" }))], { name: "Estimate" }),
    });
    const result = emit(
      draftModel([sized]),
      record({ decisions: [{ operation: "GET /api/v1/parts/{partId}/price", keep: true, capabilityId: "catalog.estimate", effect: "read" }] }),
    );
    expect(result.files.get("bindings/catalog.estimate.binding.yaml")).toMatch(/query:\n\s+widthCm: width_cm/);
  });
});

describe("emission — refusals", () => {
  it("writes NOTHING when every candidate was declined (an empty `capabilities:` is not shape-valid)", () => {
    const result = emit(draftModel([listOperation]), record({ decisions: [{ operation: "GET /api/v1/parts", keep: false }] }));
    expect(result.files.size).toBe(0);
    expect(result.notes.some((n) => n.code === "empty-confirmed-set")).toBe(true);
  });

  it("writes nothing when the company id is not a legal identifier", () => {
    const result = emit(draftModel([listOperation]), record({ company: { id: "Acme Parts!" } }));
    expect(result.files.size).toBe(0);
    expect(result.notes.some((n) => n.code === "company-id-not-derivable")).toBe(true);
  });

  it("skips a decision whose capability id is not a legal CDL id, rather than mangling it into one", () => {
    const result = emit(
      draftModel([listOperation]),
      record({ decisions: [{ operation: "GET /api/v1/parts", keep: true, capabilityId: "ListParts", effect: "read" }] }),
    );
    expect(result.skipped[0]!.code).toBe("capability-id-invalid");
  });

  it("skips a second decision claiming an id another already claimed", () => {
    const second = operation("GET", "/api/v1/parts/all");
    const result = emit(
      draftModel([listOperation, second]),
      record({
        decisions: [
          { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
          { operation: "GET /api/v1/parts/all", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
        ],
      }),
    );
    expect(result.skipped.map((s) => s.code)).toEqual(["capability-id-conflict"]);
    expect(result.capabilities).toHaveLength(1);
  });

  it("skips a candidate whose resource name is already owned with a DIFFERENT field set", () => {
    const other = operation("GET", "/api/v1/spares", {
      response: arrayOf(objectNode([property("sku", scalarNode({ type: "identifier" }))], { name: "Part" })),
    });
    const result = emit(
      draftModel([listOperation, other]),
      record({
        decisions: [
          { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
          { operation: "GET /api/v1/spares", keep: true, capabilityId: "catalog.list-spares", effect: "read" },
        ],
      }),
    );
    expect(result.skipped.map((s) => s.code)).toEqual(["resource-name-conflict"]);
  });

  it("skips a method no shipped connector can express (HEAD is not in the connector enum)", () => {
    const head = operation("HEAD", "/api/v1/parts");
    const result = emit(
      draftModel([head]),
      record({ decisions: [{ operation: "HEAD /api/v1/parts", keep: true, capabilityId: "catalog.ping", effect: "read" }] }),
    );
    expect(result.skipped[0]!.code).toBe("unsupported-connector");
  });

  it("skips a path placeholder with no matching input field — a binding that could never be invoked", () => {
    const broken = operation("GET", "/api/v1/parts/{partId}", { input: [] });
    const result = emit(
      draftModel([broken]),
      record({ decisions: [{ operation: "GET /api/v1/parts/{partId}", keep: true, capabilityId: "catalog.get-part", effect: "read" }] }),
    );
    expect(result.skipped[0]!.code).toBe("unsupported-connector");
    expect(result.skipped[0]!.detail).toContain("partId");
  });

  it("skips a decision that names a candidate the draft does not contain", () => {
    const result = emit(
      draftModel([listOperation]),
      record({ decisions: [{ operation: "GET /gone", keep: true, capabilityId: "catalog.gone", effect: "read" }] }),
    );
    expect(result.skipped[0]!.code).toBe("unknown-candidate");
  });
});

describe("emission — a mapped path must actually resolve against a real body", () => {
  it("emits a bracket path for an awkward property name, and the shipped evaluator resolves it", () => {
    const awkward = operation("GET", "/api/v1/parts", {
      response: arrayOf(
        objectNode(
          [
            property("price.usd", scalarNode({ type: "quantity", example: 5 }), { declaredRequired: true }),
            property("it's", scalarNode({ type: "string" }), { declaredRequired: true }),
          ],
          { name: "Part" },
        ),
      ),
    });
    const result = emit(draftModel([awkward]), record());
    const binding = result.files.get("bindings/catalog.list-parts.binding.yaml")!;
    expect(binding).toMatch(/price\.usd: "\$\['price\.usd'\]"/);

    // The one that matters: the emitted path is evaluated by the SAME evaluator the response
    // mapper uses. A dotted `$.price.usd` would resolve to nothing and be reported forever
    // after as a missing required field — drift that never happened.
    expect(evalPath({ "price.usd": 5 }, "$['price.usd']")).toEqual([5]);

    // A name no JSONPath can carry is left out of the map, with a named reason.
    expect(binding).not.toMatch(/it's/);
    expect(result.notes.some((n) => n.code === "field-path-not-expressible" && n.target === "catalog.list-parts#it's")).toBe(true);
  });

  it("a collection under an unaddressable property degrades instead of emitting a path that matches nothing", () => {
    const awkward = operation("GET", "/api/v1/parts", {
      response: objectNode([property("it's", arrayOf(objectNode([property("id", scalarNode({ type: "identifier" }))], { name: "Part" })))]),
    });
    const result = emit(draftModel([awkward]), record());
    expect(result.notes.some((n) => n.code === "field-path-not-expressible" && n.scope === "operation")).toBe(true);
    expect([...result.files.keys()].some((k) => k.endsWith(".resource.yaml"))).toBe(false);
  });
});

describe("emission — the degraded path hands the human what was actually seen", () => {
  it("writes the observed JSONPaths into the binding as a TODO, not as a commented-out response block", () => {
    const opaque = operation("GET", "/api/v1/health", { response: { kind: "unknown", observedPaths: ["$.status", "$.uptimeSeconds"] } });
    const result = emit(
      draftModel([opaque]),
      record({ decisions: [{ operation: "GET /api/v1/health", keep: true, capabilityId: "catalog.health", effect: "read" }] }),
    );
    const binding = result.files.get("bindings/catalog.health.binding.yaml")!;
    expect(binding).toMatch(/# {3}\$\.status/);
    expect(binding).toMatch(/# {3}\$\.uptimeSeconds/);
    // Nothing a reader could uncomment into a half-real mapping.
    expect(binding).not.toMatch(/#\s*response:/);
  });

  it("an adapter's REFUSAL is honoured, not merely recorded, and is the reason reported", () => {
    // This test used to assert the opposite, and in doing so pinned a real bug: the emitter
    // recorded the adapter's `skipsOperation: true` note and then emitted the candidate
    // anyway, skipping it (if at all) for whatever it independently noticed. `skipsOperation`
    // is not an annotation — it is a promise about the file system.
    //
    // The adapter's reason wins over anything the emitter would find later, because it is
    // upstream and more informative: "I could not read this schema" is what happened;
    // "HEAD is not a connector method" is a downstream symptom of never having a usable
    // candidate. Both notes stay visible; only one is the disposition.
    const flagged = {
      ...operation("HEAD", "/api/v1/parts"),
      notes: [{ code: "unsupported-composition" as const, scope: "operation" as const, target: "HEAD /api/v1/parts" }],
    };
    const result = emit(
      draftModel([flagged]),
      record({ decisions: [{ operation: "HEAD /api/v1/parts", keep: true, capabilityId: "catalog.ping", effect: "read" }] }),
    );
    expect(result.skipped[0]!.code).toBe("unsupported-composition");
    expect(result.notes.some((n) => n.code === "unsupported-composition")).toBe(true);
    expect(result.files.size, "a refused candidate must contribute no files at all").toBe(0);
  });
});

describe("NF-C — a shared resource name with a DIFFERENT enum set is a conflict", () => {
  it("refuses the second claimant instead of silently keeping the first's narrower values", () => {
    // `sameFields` compared name/type/required and not `values`, so these two compared equal:
    // no `resource-name-conflict`, and the emitted resource kept `[active, discontinued]`
    // while the second capability's binding still mapped onto it. The MCP `outputSchema` then
    // advertises an enum the second backend can legitimately violate — and the reference
    // client validates `structuredContent` against `outputSchema` unconditionally.
    const wide = operation("GET", "/api/v1/a", {
      response: arrayOf(
        objectNode([property("status", scalarNode({ type: "enum", nullable: false, values: ["active", "discontinued", "banned"] }), { declaredRequired: true })], { name: "Part" }),
      ),
    });
    const narrow = operation("GET", "/api/v1/b", {
      response: arrayOf(
        objectNode([property("status", scalarNode({ type: "enum", nullable: false, values: ["active", "discontinued"] }), { declaredRequired: true })], { name: "Part" }),
      ),
    });
    const result = emit(
      draftModel([wide, narrow]),
      record({
        decisions: [
          { operation: wide.key, keep: true, capabilityId: "catalog.wide", effect: "read" },
          { operation: narrow.key, keep: true, capabilityId: "catalog.narrow", effect: "read" },
        ],
      }),
    );
    expect(result.skipped.map((s) => s.code)).toContain("resource-name-conflict");
    expect(result.capabilities.map((c) => c.capabilityId)).toEqual(["catalog.wide"]);
  });

  it("identical value sets in a different ORDER are NOT a conflict — order is a rendering detail", () => {
    const a = operation("GET", "/api/v1/a", {
      response: arrayOf(objectNode([property("status", scalarNode({ type: "enum", nullable: false, values: ["x", "y"] }), { declaredRequired: true })], { name: "Part" })),
    });
    const b = operation("GET", "/api/v1/b", {
      response: arrayOf(objectNode([property("status", scalarNode({ type: "enum", nullable: false, values: ["y", "x"] }), { declaredRequired: true })], { name: "Part" })),
    });
    const result = emit(
      draftModel([a, b]),
      record({
        decisions: [
          { operation: a.key, keep: true, capabilityId: "catalog.a", effect: "read" },
          { operation: b.key, keep: true, capabilityId: "catalog.b", effect: "read" },
        ],
      }),
    );
    expect(result.skipped).toEqual([]);
    expect(result.capabilities).toHaveLength(2);
  });
});
