// IR — Archstone Intermediate Representation.
//
// The normalized, TARGET-AGNOSTIC form the compiler EMITS and every emitter
// (MCP now; REST · GraphQL · SDK later) CONSUMES. This is the physical form of
// the moat (RFC-000B): `apply` compiles to IR — it never reads YAML and hits MCP
// directly. No emit-target format (JSON Schema, MCP shapes) appears here; the MCP
// emitter (#7) owns semantic-type → JSON-Schema lowering.

export type SemanticType =
  | "location"
  | "date-range"
  | "party"
  | "preference-set"
  | "money"
  | "identifier"
  | "string"
  | "text"
  | "time-slot"
  | "quantity"
  | "enum"
  | "date"
  | "datetime";

/** The closed set of semantic types (mirrors cdl.schema.json). A field `type:` not in
 *  this set is a resource-typed reference, not a scalar. Shared by the compiler + resolver. */
export const SEMANTIC_TYPES: ReadonlySet<SemanticType> = new Set<SemanticType>([
  "location", "date-range", "party", "preference-set", "money", "identifier",
  "string", "text", "time-slot", "quantity", "enum", "date", "datetime",
]);

/** A field's type, kept neutral — emitters lower this to their target format. */
export type IRType =
  | { kind: "scalar"; semantic: SemanticType; values?: string[] } // values = closed set for `enum`
  | { kind: "resource"; name: string; identity?: true } // a `ref:` field or a resource-typed field —
    // `identity: true` ⇒ came from `ref:` ("by identity", a bare id — never expand through the
    // resource registry); absent ⇒ came from `type:`/resource-typed field ("by representation",
    // today's full-object behavior). Any future consumer that branches on `kind === "resource"`
    // MUST check `identity` before treating the field as expandable (ADD-25 R-2).
  | { kind: "collection"; of: string }; // a list of a resource

export interface IRField {
  name: string;
  required: boolean;
  description?: string;
  type: IRType;
}

export interface IRRestConnector {
  baseUrl?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  query?: Record<string, string>; // CDL input field name -> wire query-param name (issue #26)
}

/** Backend invocation data copied from the binding (not an emit-target concern). */
export interface IRConnector {
  type: "rest" | "graphql" | "grpc" | "sql" | "soap";
  rest?: IRRestConnector;
}

/** One resource field ← provider path (ADD-12). `path`/`collection` are validated
 *  JSONPath strings (syntax checked at compile time), evaluated by the runtime mapper. */
export interface IRFieldMapping {
  name: string; // a field of the mapped resource — the stable anchor
  path: string; // JSONPath into a single item (relative to `collection`, else the body root)
  requiredOverride?: false; // an explicit loosen: this field may be absent without a VIOLATION
}

/**
 * How a live provider response maps onto a named resource (binding `response:`).
 * The RESOURCE is the anchor: `map` binds resource fields to provider paths, and the
 * required set is read from the resource registry at execution — NOT stored here — so
 * the mapping and the emitted outputSchema can never disagree. `field` is the tool
 * output field the mapped result lands under (so structuredContent matches outputSchema).
 */
export interface IRResponseMapping {
  resource: string; // canonical (P-7) resource name
  field: string; // the output field the mapped array/object populates (D-7)
  collection?: string; // JSONPath to the item list; absent = single object at the body root
  fields: IRFieldMapping[];
}

/**
 * A binding's contract snapshot (ADD-18): what we last verified the provider returns.
 * `source: recorded` only — the golden fixture IS the contract, no upstream spec
 * required. Drives `archstone verify`, never the live invocation path. The fixture
 * FILE's own content (request + expects) is read directly by the runtime probe at
 * verify-time (D-6) — not lowered here, so the IR never depends on fs.
 */
export interface IRContract {
  fingerprint: string; // sha256:… of the recorded response SHAPE
  probeFixture: string; // path to the golden fixture, relative to the manifest dir
}

export interface IRTool {
  id: string; // e.g. tourism.search
  description: string;
  effect: "read" | "write" | "irreversible";
  provider: string;
  policies: string[];
  input: IRField[];
  output: IRField[];
  connector?: IRConnector; // present iff the capability has a binding (else: not invocable)
  response?: IRResponseMapping; // present iff the binding declares a response mapping (ADD-12)
  contract?: IRContract; // present iff the binding declares a contract snapshot (ADD-18)
}

/**
 * Neutral resource registry: canonical (domain-qualified) resource name → its field list.
 * A resource field's `type` may itself be `resource`/`collection`, referencing another
 * entry BY NAME (no inlining) — this carries nesting/recursion without duplication and
 * stays target-agnostic. JSON Schema is NOT here; the MCP emitter lowers this on demand.
 */
export type IRResourceRegistry = Record<string, IRField[]>;

export interface IR {
  version: "0";
  company: { id: string; name?: string };
  tools: IRTool[];
  resources: IRResourceRegistry;
}
