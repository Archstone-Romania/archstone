import { describe, it, expect } from "vitest";
import { openApiAdapter, type SourceInput } from "@archstone/init";
import {
  MEDIA_TYPE_KEYS,
  OPERATION_KEYS,
  PARAMETER_KEYS,
  PATH_ITEM_KEYS,
  REQUEST_BODY_KEYS,
  RESPONSE_KEYS,
  ROOT_KEYS,
  SILENTLY_WRONG,
  UNSUPPORTED_METHODS,
  unreadKeys,
  type KeyPolicy,
} from "../src/adapters/openapi/coverage";

// THE GUARD, AND THE INVENTORY THAT GIVES IT TEETH.
//
// `requestBody` was invisible for one structural reason: every OpenAPI object in this adapter is
// read by direct string indexing of the keys it happens to know, so nothing ever ENUMERATED an
// object's keys. An unhandled key was not merely unreported — it was never observed. No test
// could have caught it, because no test asserted that the adapter noticed everything the
// document contains.
//
// This file asserts that. Two independent statements of the same fact, which is the whole
// mechanism: `coverage.ts` says what the ADAPTER classifies, and the tables below say what
// OPENAPI DEFINES. When they disagree — a new spec revision, a feature added without declaring
// its keys, a typo in a `read` list that silently disables the guard — this fails, and someone
// has to look. It is the same instrument as the previous round's expected-candidate-count map,
// pointed at the input surface instead of at the output.

/** Keys OpenAPI 3.1 defines for each object, from the specification — NOT from `coverage.ts`.
 *  Two sources that must agree; deriving one from the other would assert nothing. */
const SPEC_KEYS = {
  operation: ["tags", "summary", "description", "externalDocs", "operationId", "parameters", "requestBody", "responses", "callbacks", "deprecated", "security", "servers"],
  pathItem: ["$ref", "summary", "description", "get", "put", "post", "delete", "options", "head", "patch", "trace", "servers", "parameters"],
  parameter: ["name", "in", "description", "required", "deprecated", "allowEmptyValue", "style", "explode", "allowReserved", "schema", "example", "examples", "content"],
  requestBody: ["description", "content", "required"],
  mediaType: ["schema", "example", "examples", "encoding"],
  response: ["description", "headers", "content", "links"],
  root: ["openapi", "info", "jsonSchemaDialect", "servers", "paths", "webhooks", "components", "security", "tags", "externalDocs"],
} as const;

const POLICIES: ReadonlyArray<readonly [keyof typeof SPEC_KEYS, KeyPolicy]> = [
  ["operation", OPERATION_KEYS],
  ["pathItem", PATH_ITEM_KEYS],
  ["parameter", PARAMETER_KEYS],
  ["requestBody", REQUEST_BODY_KEYS],
  ["mediaType", MEDIA_TYPE_KEYS],
  ["response", RESPONSE_KEYS],
  ["root", ROOT_KEYS],
];

/**
 * THE AUDIT, PINNED. Every OpenAPI-defined key that reaches the note tier — i.e. everything the
 * adapter neither reads nor argues inert nor refuses outright.
 *
 * This list is the honest scope of the adapter's blindness, written down. Changing it is a
 * scope decision: a key LEAVING this list means someone implemented it, and a key JOINING it
 * means a construct went unread. Either way the diff says so.
 */
const EXPECTED_UNREAD: Record<keyof typeof SPEC_KEYS, readonly string[]> = {
  // `callbacks` and `deprecated` are real gaps: a deprecated operation is offered to an agent
  // with no marker, and a callback is an inbound shape no capability models.
  operation: ["callbacks", "deprecated"],
  // Only a path-item-level `$ref`, which yields no candidate at all — the whole path silently
  // produces nothing. `head`/`options`/`trace` are NOT here: each raises its own
  // `unsupported-connector` note naming the exact method and path, which is strictly more useful
  // than "the path item declares `head`", and emitting both said the same thing twice.
  pathItem: ["$ref"],
  // `style`/`explode`/`allowReserved` govern wire encoding for non-scalar parameters, which are
  // now refused outright — so what remains unread here cannot change a scalar's encoding.
  // `examples` (plural) is a real gap in D-13's seeding: the singular form is read, the plural
  // is not. `allowEmptyValue` and `deprecated` are informational.
  parameter: ["deprecated", "allowEmptyValue", "style", "explode", "allowReserved", "examples"],
  requestBody: [],
  // `encoding` only applies to media types this adapter refuses anyway; `example`/`examples`
  // on a RESPONSE are report material by design (a document example is a claim about the
  // backend, and testing claims about the backend is what `contract:` is for).
  mediaType: ["example", "examples", "encoding"],
  // Response `headers` and `links` have no CDL counterpart. `links` in particular is the one
  // construct that could have informed `ref:` — R-4's headline known miss — and does not.
  response: ["headers", "links"],
  // `webhooks` is 3.1's inbound surface; `jsonSchemaDialect` would change how every schema is
  // interpreted, and is unread, which is worth knowing.
  root: ["jsonSchemaDialect", "webhooks"],
};

function noteTier(kind: keyof typeof SPEC_KEYS, policy: KeyPolicy): string[] {
  return SPEC_KEYS[kind].filter(
    (key) => !policy.read.includes(key) && !policy.inert.includes(key) && !policy.refusedElsewhere.includes(key),
  );
}

describe("the coverage inventory is complete and honest", () => {
  it.each(POLICIES)("%s: every key it claims to read is a real OpenAPI key", (kind, policy) => {
    // A typo in a `read` list is worse than a missing entry: it silently disables the guard for
    // the real key AND means the adapter is not reading it. Both at once, invisibly.
    for (const key of policy.read) {
      if (key === "$ref") continue; // structural, not an object key of its own
      expect(SPEC_KEYS[kind] as readonly string[], `'${key}' is not an OpenAPI ${kind} key`).toContain(key);
    }
  });

  it.each(POLICIES)("%s: read and inert are disjoint", (_kind, policy) => {
    for (const key of policy.inert) expect(policy.read).not.toContain(key);
  });

  it.each(POLICIES)("%s: the note tier is exactly what the audit recorded", (kind, policy) => {
    // The load-bearing assertion. If this moves, the adapter's blindness changed — in either
    // direction — and that is a thing to look at rather than a thing to re-baseline.
    expect(noteTier(kind, policy).sort()).toEqual([...EXPECTED_UNREAD[kind]].sort());
  });

  it("`requestBody` is READ, which is the assertion this whole file exists for", () => {
    // The regression guard proper. Had it been in the note tier from the start, the defect would
    // have been a report line on day one instead of a silent empty `input:`.
    expect(OPERATION_KEYS.read).toContain("requestBody");
    expect(noteTier("operation", OPERATION_KEYS)).not.toContain("requestBody");
  });
});

describe("the guard fires — the default is loud, not quiet", () => {
  it("a key nobody has classified produces a note rather than silence", () => {
    // THE PROPERTY. Not "these known keys are handled" — that is an allowlist, and an allowlist
    // is what lost `requestBody`. A key from a future revision, or one a contributor forgets to
    // declare when adding a feature, lands here by default.
    const notes = unreadKeys({ summary: "x", somethingNobodyHasThoughtOf: true }, OPERATION_KEYS, "operation", "GET /x");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.code).toBe("source-construct-not-read");
    expect(notes[0]!.detail).toMatch(/somethingNobodyHasThoughtOf/);
  });

  it("a vendor extension is not a gap", () => {
    expect(unreadKeys({ "x-internal-id": 1, "X-Other": 2 }, OPERATION_KEYS, "operation", "GET /x")).toEqual([]);
  });

  it("a read key and an argued-inert key are both silent", () => {
    expect(unreadKeys({ operationId: "a", tags: ["b"] }, OPERATION_KEYS, "operation", "GET /x")).toEqual([]);
  });

  it("a key the call site handles is not noted here — the specific disposition wins", () => {
    // A refusal is strictly louder than a note; emitting both reports the same fact twice, in
    // weaker words, and pads the group the reader is meant to scan.
    expect(unreadKeys({ servers: [] }, OPERATION_KEYS, "operation", "GET /x")).toEqual([]);
    expect(unreadKeys({ head: {}, options: {}, trace: {} }, PATH_ITEM_KEYS, "manifest", "/x")).toEqual([]);
    // Every `SILENTLY_WRONG` key must be CLAIMED by every policy that can carry it — either
    // read outright or refused at the call site — so it never falls back into the note tier and
    // gets double-reported. Note that the same key is legitimately read at one level and refused
    // at another: document-level `servers` is what the baseUrl comes from, while an
    // operation-level one means the connector would name the wrong host.
    for (const key of SILENTLY_WRONG) {
      for (const [kind, policy] of POLICIES) {
        if (!(SPEC_KEYS[kind] as readonly string[]).includes(key)) continue;
        expect(noteTier(kind, policy), `${kind} leaves '${key}' in the note tier`).not.toContain(key);
      }
    }
  });
});

/**
 * PROOF that each `refusedElsewhere` key really is refused somewhere.
 *
 * `refusedElsewhere` is a PROMISE that the call site says something more specific, and the
 * promise is what suppresses the generic note. An entry added without a real refusal would
 * therefore make a construct vanish with no note anywhere — this apparatus's own failure class,
 * one layer down, and exactly what `requestBody` did.
 *
 * Keyed `<object>:<key>`, exhaustiveness asserted below. Adding to `refusedElsewhere` without
 * adding a proof fails; adding a proof whose document does not actually refuse fails too.
 */
const REFUSAL_PROOFS: Record<string, { code: string; document: string }> = {
  "operation:servers": {
    code: "unsupported-connector",
    document: `  /a:\n    get:\n      operationId: getA\n      servers: [{url: 'https://other.test'}]\n      responses: {'200': {description: ok}}\n`,
  },
  "pathItem:servers": {
    code: "unsupported-connector",
    document: `  /a:\n    servers: [{url: 'https://other.test'}]\n    get:\n      operationId: getA\n      responses: {'200': {description: ok}}\n`,
  },
  "pathItem:head": {
    code: "unsupported-connector",
    document: `  /a:\n    head:\n      operationId: headA\n      responses: {'200': {description: ok}}\n`,
  },
  "pathItem:options": {
    code: "unsupported-connector",
    document: `  /a:\n    options:\n      operationId: optionsA\n      responses: {'200': {description: ok}}\n`,
  },
  "pathItem:trace": {
    code: "unsupported-connector",
    document: `  /a:\n    trace:\n      operationId: traceA\n      responses: {'200': {description: ok}}\n`,
  },
  "parameter:content": {
    code: "unsupported-parameter-location",
    document: `  /a:\n    get:\n      operationId: getA\n      parameters:\n        - name: filter\n          in: query\n          content:\n            application/json:\n              schema: {type: object}\n      responses: {'200': {description: ok}}\n`,
  },
};

describe("`refusedElsewhere` is a promise, and every entry has to keep it", () => {
  function adaptPaths(paths: string) {
    return openApiAdapter.adapt({
      origin: "inline",
      document: `openapi: 3.1.0\ninfo: {title: T, version: '1'}\nservers: [{url: 'https://api.test/v1'}]\npaths:\n${paths}`,
    });
  }

  it("every `refusedElsewhere` key across every policy has a proof", () => {
    // The exhaustiveness half. Without it, `refusedElsewhere` is a comment: a key added here
    // silences the guard and nothing checks that anything replaced it.
    const needed = POLICIES.flatMap(([kind, policy]) => policy.refusedElsewhere.map((key) => `${kind}:${key}`));
    expect(needed.length, "no policy refuses anything — the tier has become decorative").toBeGreaterThan(0);
    for (const id of needed) {
      expect(Object.keys(REFUSAL_PROOFS), `'${id}' is suppressed from the coverage guard with no proof that anything refuses it`).toContain(id);
    }
  });

  it("no proof is stale — each names a key some policy actually suppresses", () => {
    const needed = new Set(POLICIES.flatMap(([kind, policy]) => policy.refusedElsewhere.map((key) => `${kind}:${key}`)));
    for (const id of Object.keys(REFUSAL_PROOFS)) expect([...needed], `'${id}' proves a suppression nothing declares`).toContain(id);
  });

  it.each(Object.entries(REFUSAL_PROOFS))("%s really is refused, with a specific code", (id, proof) => {
    // The behavioural half: the construct must produce its OWN named disposition, and it must
    // not be the generic note (which `refusedElsewhere` suppressed).
    const draft = adaptPaths(proof.document);
    const codes = [...draft.notes, ...draft.operations.flatMap((o) => o.notes)].map((n) => n.code);
    expect(codes, `${id}: nothing refuses it, so the construct drops in total silence`).toContain(proof.code);
    expect(codes, `${id}: suppressed AND unrefused`).not.toContain("source-construct-not-read");
  });
});

describe("the two escalations, end to end", () => {
  function adapt(document: string) {
    const input: SourceInput = { origin: "inline", document };
    return openApiAdapter.adapt(input);
  }

  const base = `openapi: 3.1.0
info: {title: T, version: '1'}
servers: [{url: 'https://api.test/v1'}]
paths:
`;

  it("an operation with its own `servers` refuses — the connector would name the wrong host", () => {
    const draft = adapt(`${base}  /a:
    get:
      operationId: getA
      servers: [{url: 'https://other.test'}]
      responses: {'200': {description: ok}}
`);
    const codes = draft.operations[0]!.notes.map((n) => n.code);
    expect(codes).toContain("unsupported-connector");
  });

  it("a `HEAD`/`OPTIONS`/`TRACE` operation is reported rather than vanishing", () => {
    // It produced no candidate and no word about it before: the endpoint simply disappeared
    // between the document and the report. Same silence as `requestBody`, one object higher.
    const draft = adapt(`${base}  /a:
    head:
      operationId: headA
      responses: {'200': {description: ok}}
    trace:
      operationId: traceA
      responses: {'200': {description: ok}}
`);
    expect(draft.operations).toHaveLength(0);
    const targets = draft.notes.filter((n) => n.code === "unsupported-connector").map((n) => n.target);
    expect(targets).toEqual(expect.arrayContaining(["HEAD /v1/a", "TRACE /v1/a"]));
    expect(UNSUPPORTED_METHODS).toContain("head");
  });

  it("a parameter declared with `content:` refuses rather than degrading to `string`", () => {
    const draft = adapt(`${base}  /a:
    get:
      operationId: getA
      parameters:
        - name: filter
          in: query
          content:
            application/json:
              schema: {type: object}
      responses: {'200': {description: ok}}
`);
    const codes = draft.operations[0]!.notes.map((n) => n.code);
    expect(codes).toContain("unsupported-parameter-location");
  });

  it("a path-item `$ref` is reported — the whole path produced nothing", () => {
    const draft = adapt(`${base}  /a:
    $ref: './elsewhere.yaml#/paths/~1a'
`);
    expect(draft.operations).toHaveLength(0);
    const detail = draft.notes.filter((n) => n.code === "source-construct-not-read").map((n) => n.detail).join(" ");
    expect(detail).toMatch(/\$ref/);
  });
});
