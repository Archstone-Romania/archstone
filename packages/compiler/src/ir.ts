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

/** A field's type, kept neutral — emitters lower this to their target format. */
export type IRType =
  | { kind: "scalar"; semantic: SemanticType; values?: string[] } // values = closed set for `enum`
  | { kind: "resource"; name: string } // a `ref:` field or a resource-typed field
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
}

/** Backend invocation data copied from the binding (not an emit-target concern). */
export interface IRConnector {
  type: "rest" | "graphql" | "grpc" | "sql" | "soap";
  rest?: IRRestConnector;
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
}

export interface IR {
  version: "0";
  company: { id: string; name?: string };
  tools: IRTool[];
}
