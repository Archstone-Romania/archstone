import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  emit,
  isKnown,
  locusCandidates,
  selectLocus,
  openApiAdapter,
  valueOrUndefined,
  type DecisionRecord,
  type DraftNode,
  type DraftObjectNode,
  type SourceInput,
} from "@archstone/init";
import { commitFileSet } from "@archstone/init/loop";
import { assertAdapterConformance } from "./conformance";

// ADD-37 §6 step 5 — the OpenAPI 3.x adapter, amended by D-10/D-11/D-12/D-13.
//
// Every fixture here is SYNTHETIC. The real oracle this increment was measured against is a
// design partner's live API contract, and vendoring one into the public open-core tree is
// precisely the mistake #35 was filed to undo — so the measurement is a one-off run reported
// in the increment's write-up, and what is committed is an invented "Acme Parts" API with the
// same STRUCTURE.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

/**
 * The host's half of D-11: resolve → supply → re-ask, until closure or a cap.
 *
 * Deliberately duplicated here in miniature rather than imported from the loop, so this file
 * proves the ADAPTER's contract (`references()` converges, and `adapt()` needs nothing else)
 * without depending on the loop's fs behaviour.
 */
function loadWithReferences(primary: string, origin = primary): SourceInput {
  const input: SourceInput = { origin, document: read(primary), documents: {} };
  const unreadable = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const wanted = openApiAdapter
      .references!(input)
      .filter((key) => input.documents![key] === undefined && !unreadable.has(key));
    if (wanted.length === 0) return input;
    for (const key of wanted) {
      // A reference the host cannot satisfy is NOT an error here — the quirks fixture points
      // at a file that does not exist on purpose. The host supplies what it can and the
      // adapter reports what is still missing, which is the whole division of labour in D-11.
      try {
        input.documents![key] = read(key);
      } catch {
        unreadable.add(key);
      }
    }
  }
  throw new Error("reference closure did not converge");
}

const catalog = openApiAdapter.adapt(loadWithReferences("catalog.yaml"));
const quirks = openApiAdapter.adapt(loadWithReferences("quirks.yaml"));

function operation(draft: typeof catalog, key: string) {
  const found = draft.operations.find((o) => o.key === key);
  expect(found, `no operation keyed '${key}'`).toBeDefined();
  return found!;
}

function codes(draft: typeof catalog, key: string): string[] {
  return operation(draft, key).notes.map((n) => n.code);
}

function objectOf(node: DraftNode): DraftObjectNode {
  expect(node.kind).toBe("object");
  return node as DraftObjectNode;
}

function property(node: DraftNode, name: string) {
  const found = objectOf(node).properties.find((p) => p.name === name);
  expect(found, `no property '${name}'`).toBeDefined();
  return found!;
}

describe("the OpenAPI adapter satisfies the SourceAdapter contract (D-1)", () => {
  it("conforms, on every fixture, including ones it cannot handle", () => {
    assertAdapterConformance(openApiAdapter, [loadWithReferences("catalog.yaml"), loadWithReferences("quirks.yaml")]);
  });

  it("refuses a non-3.x document rather than reading it with 3.x rules", () => {
    // A Swagger 2.0 document uses `definitions`, `basePath` and a different parameter model.
    // Reading it here would produce a manifest that is confidently wrong instead of honestly
    // absent — the one failure mode this whole increment is built to avoid.
    const draft = openApiAdapter.adapt({ origin: "swagger", document: "swagger: '2.0'\npaths: {}\n" });
    expect(draft.operations).toEqual([]);
    expect(draft.notes.map((n) => n.detail).join(" ")).toMatch(/not an OpenAPI 3\.x document/);
  });
});

describe("D-11 — the multi-file `$ref` closure", () => {
  it("asks the host for the documents it needs, and stops asking once it has them", () => {
    const bare: SourceInput = { origin: "catalog.yaml", document: read("catalog.yaml") };
    expect(openApiAdapter.references!(bare)).toEqual(["shared.yaml"]);
    const closed = loadWithReferences("catalog.yaml");
    expect(openApiAdapter.references!(closed)).toEqual([]);
  });

  it("resolves a cross-file component into the merged shape", () => {
    // `Pagination` lives in the other file and reaches `PartList` only through `allOf`.
    // Without D-11 the adapter cannot see it at all — and must then fail closed, because an
    // unresolved member could contribute an array-of-objects property and change the census.
    const response = operation(catalog, "GET /api/v2/parts").response;
    expect(objectOf(response).properties.map((p) => p.name)).toEqual(["items", "total", "page", "limit"]);
  });

  it("fails closed on a document the host never supplied — no half-read shape", () => {
    expect(codes(quirks, "GET /api/v2/missing-document")).toContain("unsupported-ref");
    expect(operation(quirks, "GET /api/v2/missing-document").response.kind).toBe("unknown");
  });

  it("never fetches a URL, and never climbs out of the document's own subtree", () => {
    expect(codes(quirks, "GET /api/v2/remote")).toContain("unsupported-ref");
    expect(codes(quirks, "GET /api/v2/escaping")).toContain("unsupported-ref");
    // The escape must not even be REQUESTED of the host: `references()` is what the host
    // dereferences, so a `..` leaking into it turns a spec file into a file-read primitive.
    expect(openApiAdapter.references!(loadWithReferences("quirks.yaml")).some((k) => k.includes(".."))).toBe(false);
  });

  it("terminates on a circular `$ref` instead of overflowing the stack", () => {
    expect(codes(quirks, "GET /api/v2/circular")).toContain("unsupported-ref");
  });
});

describe("D-10 — `allOf` is a merge, not a choice", () => {
  const listItem = objectOf(objectOf(operation(catalog, "GET /api/v2/parts").response).properties.find((p) => p.name === "items")!.node.kind === "array" ? (objectOf(operation(catalog, "GET /api/v2/parts").response).properties.find((p) => p.name === "items")!.node as { kind: "array"; items: DraftNode }).items : { kind: "unknown" });

  it("D-10.1 — sibling keywords compose: `properties` beside `allOf` survives", () => {
    // The failure this guards: reading `allOf` as "the schema IS its members" loses
    // `PartList.items`, and with it the entire list capability.
    const response = objectOf(operation(catalog, "GET /api/v2/parts").response);
    const items = response.properties.find((p) => p.name === "items")!;
    expect(items.node.kind).toBe("array");
    expect(response.properties.map((p) => p.name)).toContain("total");
  });

  it("D-10.2 — merges three levels deep (ListItem → Base → GeometryFields)", () => {
    expect(listItem.properties.map((p) => p.name).sort()).toEqual(
      ["description", "finish", "id", "material", "name", "photos", "pricePerUnit", "profileType", "webThicknessMm", "widthMm"].sort(),
    );
  });

  it("D-10.2 — the merge completes BEFORE D-9 sees the node", () => {
    // Stated as a property of the output rather than of the call order: no node anywhere in a
    // successfully-adapted operation still carries composition, so the decision procedure
    // cannot encounter one.
    const serialized = JSON.stringify(catalog.operations);
    expect(serialized).not.toMatch(/"allOf"|"oneOf"|"anyOf"|"\$ref"/);
  });

  it("D-10.3 — a member contributing only a `description` is a no-op, not a contradiction", () => {
    // `PartListItem.allOf[2]` is an object schema with a description and no properties. An
    // implementation that treats that as a constraint empties the whole shape.
    expect(listItem.properties.length).toBeGreaterThan(0);
  });

  it("D-10.3 — `required` is a set union across members", () => {
    expect(property(listItem, "photos").declaredRequired).toMatchObject({ derivation: "declared", value: true });
    expect(property(listItem, "id").declaredRequired).toMatchObject({ derivation: "declared", value: true });
    expect(property(listItem, "profileType").declaredRequired).toMatchObject({ derivation: "declared", value: true });
  });

  it("D-10.4 — a conflicting scalar property is FIELD-scoped: the operation survives", () => {
    const op = operation(quirks, "GET /api/v2/conflicting-field");
    expect(op.notes.map((n) => n.code)).toContain("composition-conflict");
    // The operation is not skipped — escalating one bad property to an operation skip would
    // re-open the 100%-skip failure D-10 exists to close.
    expect(op.notes.map((n) => n.code)).not.toContain("unsupported-composition");
    expect(property(op.response, "value").node.kind).toBe("unknown");
  });

  it("D-10.4's exception — an array-of-objects disagreement ESCALATES to an operation skip", () => {
    // The one place a field-level unknown may change a structural decision. An `unknown` node
    // is invisible to `locateItemLocus`, so a genuinely ambiguous response would be rounded
    // down to "exactly one collection" — a guess wearing the costume of a refusal.
    expect(codes(quirks, "GET /api/v2/conflicting-collection")).toContain("unsupported-composition");
    expect(operation(quirks, "GET /api/v2/conflicting-collection").response.kind).toBe("unknown");
  });

  it("D-10.3's `type` clause — members that disagree about the structural kind are refused", () => {
    // The merge unions `type` sets, which is right for `[string, 'null']` and wrong for a
    // contradiction: `allOf: [{type: array}, {type: object}]` unions to `{array, object}` and
    // would otherwise be resolved silently by whichever check runs first. The structural kind
    // is a direct input to D-9 step 1, so a quietly-chosen `array` would present itself as a
    // collection the document never described.
    expect(codes(quirks, "GET /api/v2/contradictory-kind")).toContain("unsupported-composition");
    expect(operation(quirks, "GET /api/v2/contradictory-kind").response.kind).toBe("unknown");
  });

  it("D-10.4 — members that AGREE it is a list but disagree about the item also escalate", () => {
    // The escalation used to fire only when candidates disagreed about BEING an
    // array-of-objects. Two members can agree a key is a list and still disagree about the
    // item (`results: array<Alpha>` vs `array<Beta>`); that fell through to a field-scoped
    // conflict, the property became `unknown`, and `locateItemLocus` filters on
    // `isArrayOfObjects` — which `unknown` fails. The collection vanished from the census and
    // an operation both sides agreed returns a list degraded to connector-only, silently.
    //
    // The governing rule is "escalate whenever a disagreement could change any input to D-9
    // step 1", not the single case one document happened to show.
    expect(codes(quirks, "GET /api/v2/agreeing-collections")).toContain("unsupported-composition");
    expect(codes(quirks, "GET /api/v2/agreeing-collections")).not.toContain("composition-conflict");
    expect(operation(quirks, "GET /api/v2/agreeing-collections").response.kind).toBe("unknown");
  });

  it("a scalar-only conflict stays FIELD-scoped — the escalation did not widen into everything", () => {
    // The negative control for the rule above: broadening the escalation must not turn every
    // composition conflict into an operation skip, which would re-open the 100%-skip failure
    // D-10 exists to close.
    const op = operation(quirks, "GET /api/v2/conflicting-field");
    expect(op.notes.map((n) => n.code)).toContain("composition-conflict");
    expect(op.notes.map((n) => n.code)).not.toContain("unsupported-composition");
    expect(op.response.kind).toBe("object");
  });

  it("D-10.5 — a `discriminator` is refused, never merged", () => {
    expect(codes(quirks, "GET /api/v2/discriminated")).toContain("unsupported-composition");
  });

  it("D-10.6 — the null idiom reduces; real polymorphism does not", () => {
    const estimate = operation(catalog, "GET /api/v2/parts/{id}/price").response;
    const geometry = property(estimate, "geometry");
    // `oneOf: [PartGeometry, {type: null}]` → PartGeometry, marked nullable. Reducing this is
    // what keeps the whole price capability alive.
    expect(geometry.node.kind).toBe("object");
    expect(codes(quirks, "GET /api/v2/polymorphic")).toContain("unsupported-composition");
  });
});

describe("A-3 — nullability, from all four sources, as POSITIVE evidence (D-12's adapter half)", () => {
  const listItem = (() => {
    const items = objectOf(operation(catalog, "GET /api/v2/parts").response).properties.find((p) => p.name === "items")!;
    return objectOf((items.node as { kind: "array"; items: DraftNode }).items);
  })();

  it("source 1 — a 3.1 `type: [X, 'null']` union is nullable", () => {
    const node = property(listItem, "widthMm").node;
    expect(node.kind === "scalar" && node.nullable).toMatchObject({ derivation: "declared", value: true });
  });

  it("a `type` that EXCLUDES null is positive evidence of non-nullability, not silence", () => {
    // The load-bearing half of D-12. An adapter that left `nullable` absent here would make
    // every field optional — visibly wrong in the diff harness (DoD-3d), which is the right
    // place for that mistake to land.
    const node = property(listItem, "id").node;
    expect(node.kind === "scalar" && node.nullable).toMatchObject({ derivation: "declared", value: false });
  });

  it("source 3 — a reduced `oneOf` marks the survivor nullable", () => {
    const estimate = operation(catalog, "GET /api/v2/parts/{id}/price").response;
    expect(property(estimate, "estimatedPrice").node).toMatchObject({ nullable: { derivation: "declared", value: true } });
  });

  it("source 4 — an `enum` containing null is nullable AND drops null from `values`", () => {
    // Two consequences, and the second is the easily-missed emission bug: `cdl.schema.json`
    // declares `values.items: {type: string}` with `minItems: 1`, so a `null` in there makes
    // the emitted file shape-invalid, the loop's compile check fails, D-7 refuses, and the run
    // writes nothing — loud, but it costs the whole run for one enum.
    const finish = property(listItem, "finish").node;
    expect(finish.kind === "scalar" && finish.nullable).toMatchObject({ derivation: "declared", value: true });
    expect(finish.kind === "scalar" && finish.values).toEqual(["matte", "brushed", "anodised"]);
    expect(finish.kind === "scalar" && finish.values).not.toContain(null);
  });

  it("nullability is ABSENT — never assumed — when nothing in the schema settles it", () => {
    const op = operation(quirks, "GET /api/v2/conflicting-field");
    // The conflict node is `unknown`, so there is no scalar to classify; the point is that the
    // adapter never manufactured a `declared(false)` to fill the hole.
    expect(property(op.response, "value").node.kind).toBe("unknown");
  });
});

describe("A-3 — `const`, and the types CDL does not have", () => {
  it("a string `const` lowers to a one-value enum, so the field does not vanish from the map", () => {
    const estimate = operation(catalog, "GET /api/v2/parts/{id}/price").response;
    const currency = property(estimate, "currency").node;
    expect(currency.kind === "scalar" && valueOrUndefined(currency.type)).toBe("enum");
    expect(currency.kind === "scalar" && currency.values).toEqual(["EUR"]);
  });
});

describe("D-13 — spec examples seed the gate, and only the gate", () => {
  it("an `example:` on a parameter reaches `DraftInputField.example`, with its locator", () => {
    const price = operation(catalog, "GET /api/v2/parts/{id}/price");
    const width = price.input.find((f) => f.name === "width_cm")!;
    expect(isKnown(width.example) && width.example.value).toBe(50);
    expect(isKnown(width.example) && width.example.source).toMatch(/\/example$/);
  });

  it("a schema `default:` is used only when there is no `example:`, and says which it was", () => {
    // Not decoration: a `default` means "the same as omitting the parameter", an `example` is
    // someone's illustration, and a human confirming a LIVE call deserves to see which.
    const list = operation(catalog, "GET /api/v2/parts");
    const page = list.input.find((f) => f.name === "page")!;
    expect(isKnown(page.example) && page.example.value).toBe(1);
    expect(isKnown(page.example) && page.example.source).toMatch(/\/schema\/default$/);
  });

  it("an example is never an `effect`, and never a probe input on its own", () => {
    // `effectHint : effect :: example : sampleInput`. The adapter can pre-fill a question; it
    // can never answer one. A probe is a live request to a production backend carrying a value
    // the human did not choose — and `id.example: AC45` looks exactly like a real record.
    const price = operation(catalog, "GET /api/v2/parts/{id}/price");
    expect(price.effectHint).toMatchObject({ derivation: "heuristic", value: "read" });
    expect(JSON.stringify(price)).not.toMatch(/sampleInput/);
  });
});

describe("§A-5 — auth is per operation, with a value template", () => {
  it("`security: []` is a positive statement that the operation is public", () => {
    // Not the same as saying nothing: it must OVERRIDE a manifest-level default, or every
    // public capability becomes un-invocable until the user sets a token they do not need.
    expect(operation(catalog, "GET /api/v2/parts").auth).toEqual({ kind: "none" });
  });

  it("a bearer scheme reduces to an `Authorization` header carrying a `Bearer ` prefix", () => {
    expect(operation(catalog, "GET /api/v2/admin/parts").auth).toEqual({
      kind: "header",
      headerName: "Authorization",
      valuePrefix: "Bearer ",
      scheme: "http/bearer",
    });
  });

  it("the adapter never names an environment variable — that is the human's answer", () => {
    expect(JSON.stringify(catalog)).not.toMatch(/API_TOKEN/);
  });

  it("a scheme that does not reduce to a header skips the operation, rather than 401ing forever", () => {
    expect(codes(quirks, "GET /api/v2/query-key")).toContain("unsupported-security-scheme");
    expect(codes(quirks, "GET /api/v2/oauth")).toContain("unsupported-security-scheme");
  });

  it("`http/basic` is refused too — it LOOKS reducible and is not (NF-B)", () => {
    // The trap: `Authorization: Basic ${ENV}` type-checks, compiles and reads correctly, but
    // RFC 7617 makes the value `base64(username:password)`, not a token. Emitting it would
    // tell the user to "set ACME_API_TOKEN" for something that is not a token, and hand them a
    // 401 to reverse-engineer. Refusing is the same call the ADD makes for a query-string key.
    expect(codes(quirks, "GET /api/v2/basic-auth")).toContain("unsupported-security-scheme");
  });
});

describe("connector, servers and candidate metadata", () => {
  it("splits `servers[0].url` into an env-placeholder baseUrl and a path prefix", () => {
    // A prefix baked into the env var would make staging and production disagree about where
    // the version segment lives.
    expect(valueOrUndefined(catalog.baseUrl)).toBe("https://api.acme.test");
    expect(catalog.operations.every((o) => o.path.startsWith("/api/v2/"))).toBe(true);
  });

  it("slugifies `operationId` into an action half, and leaves the DOMAIN to the human", () => {
    expect(valueOrUndefined(operation(catalog, "GET /api/v2/parts").suggestedAction)).toBe("list-parts");
    expect(valueOrUndefined(operation(catalog, "GET /api/v2/parts/{id}/price").suggestedAction)).toBe("estimate-part-price");
    // `company.id` and the domain half of a capability id are never derived: no OpenAPI
    // construct carries either, and a wrong guess names the wrong company in every file.
    expect(catalog.company.id.derivation).toBe("absent");
  });

  it("prefers `summary` over a page of Markdown `description`", () => {
    const description = valueOrUndefined(operation(catalog, "GET /api/v2/parts").description);
    expect(description).toBe("List the parts Acme can supply");
    expect(description).not.toMatch(/\n/);
  });

  it("reports declared error responses as an unmapped affordance, and emits no `failures:`", () => {
    expect(codes(catalog, "GET /api/v2/parts")).toContain("failures-not-emitted");
  });

  it("refuses a header parameter and a non-JSON response by name", () => {
    expect(codes(quirks, "GET /api/v2/header-param")).toContain("unsupported-parameter-location");
    expect(codes(quirks, "GET /api/v2/csv")).toContain("unsupported-media-type");
  });

  it("every refusal in the quirks document is a named code, and none of them threw", () => {
    // The scope boundary, asserted as a whole rather than construct by construct: an
    // unhandled construct must be reportable data, never a stack trace and never silence.
    for (const op of quirks.operations) {
      expect(op.notes.length, `${op.key} produced no note at all`).toBeGreaterThan(0);
    }
  });
});

describe("adapter → emit → the real compiler: the whole path, end to end", () => {
  // The point of the loop (D-7): the terminal states are "a compiling manifest was written" or
  // "nothing was written and here is why". An adapter whose output the shipped compiler rejects
  // has not produced a manifest, it has produced a draft — and the difference is the product.
  const decisions: DecisionRecord = {
    version: "0",
    company: { id: "acme", name: "Acme Parts" },
    provider: "acme-api",
    decisions: [
      { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" },
      { operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
      { operation: "GET /api/v2/admin/parts", keep: true, capabilityId: "catalog.admin-list-parts", effect: "read", responseLocus: "$.items[*]" },
    ],
  };

  let workspace: string;
  let emitted: ReturnType<typeof emit>;
  let committed: ReturnType<typeof commitFileSet>;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "archstone-init-openapi-"));
    emitted = emit(catalog, decisions);
    committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("compiles through `load` → `validateSemantics` → `compile` → `Registry`, unmodified", () => {
    expect(committed.failures).toEqual([]);
    expect(committed.ok).toBe(true);
    expect(committed.ir!.tools).toHaveLength(3);
  });

  it("the enum whose source carried `null` survives shape validation", () => {
    // A-3's easily-missed emission bug, checked where it actually bites: a `null` inside
    // `values:` makes the file shape-invalid, the loop's own compile check fails, and D-7 then
    // refuses the WHOLE run for one enum. `committed.ok` above is the assertion; this pins the
    // emitted bytes so a regression is legible rather than just red.
    const resource = [...emitted.files].find(([k]) => k.endsWith("PartListItem.resource.yaml"))![1];
    expect(resource).toMatch(/values: \[matte, brushed, anodised\]/);
  });

  it("a bearer-protected operation gets a header; a public one does not", () => {
    const admin = emitted.files.get("bindings/catalog.admin-list-parts.binding.yaml")!;
    const list = emitted.files.get("bindings/catalog.list-parts.binding.yaml")!;
    expect(admin).toMatch(/Authorization: "Bearer \$\{ACME_API_TOKEN\}"/);
    expect(list).not.toMatch(/headers:/);
  });

  it("emits none of the four forbidden keys, anywhere in the file set", () => {
    // Challenge 2, asserted over the WHOLE emitted set rather than one sampled file, because
    // each of these is a well-meant default a later contributor adds back somewhere else.
    for (const [path, content] of emitted.files) {
      expect(content, `${path} emits lifecycle:`).not.toMatch(/^\s*lifecycle:/m);
      expect(content, `${path} emits policies:`).not.toMatch(/^\s*policies:/m);
      expect(content, `${path} emits failures:`).not.toMatch(/^\s*failures:/m);
      expect(content, `${path} emits contract: with no recorded fixture`).not.toMatch(/^\s*contract:/m);
      expect(content, `${path} emits a caller placeholder`).not.toMatch(/\$\{caller\./);
    }
  });
});

describe("D-14 — the locus is a choice, asked and confirmed (Amendment 2)", () => {
  // THE DEFECT THIS REPLACES, so the flip is legible: `PartQuote` is
  // `{quotedPrice, currency, warnings: array<QuoteWarning>}`, and §1.1 step 1's branch order
  // selected the only array-of-objects — emitting, for the operation whose entire purpose is
  // to return a price, a capability whose entire output was a list of advisory warnings. It
  // compiled, passed `apply`, served, and wrote files.
  //
  // O-21 is why it could not be patched with a better rule: `PartList`
  // (`{items[], total, page, limit}`) is STRUCTURALLY IDENTICAL — one array-of-objects, scalar
  // siblings, array declared required. Only the names differ, and name-based inference is what
  // this increment refuses. So the locus joins `effect`, the resource name and `sampleInput`
  // as a thing the human confirms.

  const decisionsFor = (locus?: string): DecisionRecord => ({
    version: "0",
    company: { id: "acme" },
    provider: "acme-api",
    decisions: [
      {
        operation: "GET /api/v2/parts/{id}/quote",
        keep: true,
        capabilityId: "catalog.quote-part",
        effect: "read",
        ...(locus !== undefined ? { responseLocus: locus } : {}),
      },
    ],
  });

  it("with NO locus supplied: refused, zero files — a choice exists and nobody made it", () => {
    const emitted = emit(catalog, decisionsFor());
    expect(emitted.files.size).toBe(0);
    expect(emitted.skipped.map((s) => s.code)).toEqual(["ambiguous-collection"]);
    // The refusal must be actionable: it names the candidates AND their fields, because
    // "$.warnings[*] or root?" is not a question anyone can answer from paths alone (R-11).
    const detail = emitted.skipped[0]!.detail ?? "";
    expect(detail).toContain("root (quotedPrice, currency)");
    expect(detail).toContain("$.warnings[*] (code, message)");
  });

  it("with `responseLocus: root`: the capability returns the QUOTE, which is the point", () => {
    const emitted = emit(catalog, decisionsFor("root"));
    const binding = emitted.files.get("bindings/catalog.quote-part.binding.yaml")!;
    expect(binding).toMatch(/resource: catalog\.PartQuote/);
    expect(binding).toMatch(/quotedPrice: "\$\.quotedPrice"/);
    expect(binding).toMatch(/currency: "\$\.currency"/);
    expect(binding).not.toMatch(/collection:/);
    // D-16: the dropped `warnings` list is reported as UNRECOVERABLE by hand, not as a
    // deferred convenience — a second resource needs a second `response:` block, and a binding
    // carries one (O-23).
    const nested = emitted.notes.find((n) => n.code === "nested-object-not-mapped" && (n.target ?? "").endsWith("#warnings"));
    expect(nested?.detail).toMatch(/cannot be recovered by hand/);
  });

  it("with the array selected: today's bytes, PLUS a note naming what was dropped (D-15)", () => {
    const emitted = emit(catalog, decisionsFor("$.warnings[*]"));
    const binding = emitted.files.get("bindings/catalog.quote-part.binding.yaml")!;
    expect(binding).toMatch(/collection: "\$\.warnings\[\*\]"/);
    expect(binding).toMatch(/resource: catalog\.QuoteWarning/);
    // D-15 — the human chose the list and the scalars are still gone. That is exactly when a
    // silent drop is most defensible and therefore most worth writing down.
    const dropped = emitted.notes.find((n) => n.scope === "operation" && (n.detail ?? "").includes("NOT mapped"));
    expect(dropped?.detail).toContain("quotedPrice");
    expect(dropped?.detail).toContain("currency");
    // And in the ARTIFACT, not only the report: the binding is what gets reviewed months later.
    expect(binding).toMatch(/top-level field\(s\) are NOT mapped/);
    expect(binding).toMatch(/quotedPrice, currency/);
  });

  it("a locus that matches no candidate refuses, rather than falling back to the pre-fill", () => {
    const emitted = emit(catalog, decisionsFor("$.nope[*]"));
    expect(emitted.files.size).toBe(0);
    expect(emitted.skipped[0]!.detail).toContain("matches no candidate");
  });
});

describe("D-14 must not tax the shapes that were never ambiguous (B-5)", () => {
  it("`PartList` — pre-fill + confirm reproduces the paginated-list output exactly", () => {
    // THE TEST THAT PROVES THE FIX DID NOT BUY CORRECTNESS WITH THE COMMON CASE. A paginated
    // list is the single most common response shape in real APIs; if D-14 broke it, the cure
    // would be worse than the disease.
    const emitted = emit(catalog, {
      version: "0",
      company: { id: "acme" },
      provider: "acme-api",
      decisions: [
        { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" },
      ],
    });
    const binding = emitted.files.get("bindings/catalog.list-parts.binding.yaml")!;
    expect(binding).toMatch(/collection: "\$\.items\[\*\]"/);
    expect(binding).toMatch(/resource: catalog\.PartListItem/);
    expect(emitted.capabilities[0]!.resource).toBe("catalog.PartListItem");
    // D-15 still fires — pagination metadata IS dropped, and saying so is the honest thing
    // even when the choice is obviously right.
    const dropped = emitted.notes.find((n) => n.scope === "operation" && (n.detail ?? "").includes("NOT mapped"));
    expect(dropped?.detail).toContain("total");
  });

  it("`PriceEstimate` — one candidate, so no question is asked and none is needed", () => {
    // Proves the keystroke cost is proportional: only genuinely ambiguous shapes are taxed.
    const census = locusCandidates(operation(catalog, "GET /api/v2/parts/{id}/price").response);
    expect(census.candidates).toHaveLength(1);
    expect(census.candidates[0]!.kind).toBe("root");
    const emitted = emit(catalog, {
      version: "0",
      company: { id: "acme" },
      provider: "acme-api",
      decisions: [{ operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" }],
    });
    expect(emitted.files.size).toBeGreaterThan(0);
    expect(selectLocus(census, undefined).kind).toBe("selected");
  });

  it("`AgreeingCollections` reaches ZERO candidates — a refusal upstream wins, and the count says so", () => {
    // This test used to be named for the ≥3-candidate path and assert only the outcome. It
    // was measuring nothing: D-10.4's escalation (BF-2) refuses this operation before
    // `locusCandidates` is ever called, so the census never runs. Two individually correct
    // rules had made the designated fixture structurally incapable of reaching the code it was
    // designated for — and the suite said nothing, because the outcome assertion still passed.
    //
    // Asserting the CANDIDATE COUNT rather than the outcome is what makes that visible.
    expect(codes(quirks, "GET /api/v2/agreeing-collections")).toContain("unsupported-composition");
    expect(locusCandidates(operation(quirks, "GET /api/v2/agreeing-collections").response).candidates).toHaveLength(0);
  });

  it("`PartReport` reaches the census with THREE candidates — the ≥3 path, genuinely exercised", () => {
    // Composition-free on purpose, so nothing refuses it upstream. Root scalars plus two
    // independent lists is an ordinary shape, and it is the one that proved the gate's prompt
    // was hard-coded to say "two ways".
    const census = locusCandidates(operation(catalog, "GET /api/v2/parts/{id}/report").response);
    expect(census.candidates.map((c) => c.id)).toEqual(["root", "$.defects[*]", "$.substitutes[*]"]);
    expect(selectLocus(census, undefined).kind).toBe("ambiguous");
    expect(selectLocus(census, "$.substitutes[*]").kind).toBe("selected");
  });

  it("with three candidates and no answer, the refusal names all three with their fields", () => {
    const emitted = emit(catalog, {
      version: "0",
      company: { id: "acme" },
      provider: "acme-api",
      decisions: [{ operation: "GET /api/v2/parts/{id}/report", keep: true, capabilityId: "catalog.report-part", effect: "read" }],
    });
    expect(emitted.files.size).toBe(0);
    const detail = emitted.skipped[0]!.detail ?? "";
    expect(detail).toContain("3 places");
    expect(detail).toContain("root (generatedAt)");
    expect(detail).toContain("$.defects[*] (code, message)");
    expect(detail).toContain("$.substitutes[*] (id, imageUrl)");
  });
});

describe("a fixture named for a path must actually REACH that path", () => {
  // The general guard the ≥3-candidate miss earned. A test can be named for a code path,
  // assert an outcome that happens to hold for an unrelated reason, and pass forever while the
  // path it was written for is unreachable. Asserting the SHAPE the path consumes — here, the
  // candidate count — is what catches that; asserting the outcome is not.
  const expectedCandidateCounts: Record<string, number> = {
    "GET /api/v2/parts": 2, // paginated list: the list, or the paginated root
    "GET /api/v2/parts/{id}": 2, // detail scalars + its `photos` list — caught by this very guard,
    //                            after I asserted 1 from memory of the schema rather than from it
    "GET /api/v2/parts/{id}/price": 1, // scalars + a nested object, no list
    "GET /api/v2/parts/{id}/quote": 2, // the C-1 shape: payload scalars + an advisory list
    "GET /api/v2/parts/{id}/report": 3, // root scalars + two independent lists
    "GET /api/v2/admin/parts": 2,
  };

  for (const [key, expected] of Object.entries(expectedCandidateCounts)) {
    it(`${key} presents ${expected} candidate locus/loci`, () => {
      expect(locusCandidates(operation(catalog, key).response).candidates).toHaveLength(expected);
    });
  }

  it("the map above covers every operation in the fixture, so a new one cannot slip past", () => {
    expect(catalog.operations.map((o) => o.key).sort()).toEqual(Object.keys(expectedCandidateCounts).sort());
  });
});
