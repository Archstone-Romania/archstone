// @archstone/compiler — Compiler (#4)
//
// Lowers the shape-valid, semantically-resolved model (from #2/#3) into IR.
// Pure: model -> IR. No MCP SDK, no HTTP. Assumes the model passed the semantic
// pass (validateSemantics); it builds what it can regardless.

import type { LoadResult, CapabilityDoc } from "@archstone/schema";
import type { IR, IRTool, IRField, IRType, IRConnector, IRRestConnector, SemanticType } from "./ir";

const CONNECTOR_TYPES = new Set<IRConnector["type"]>(["rest", "graphql", "grpc", "sql", "soap"]);

const SEMANTIC_TYPES = new Set<SemanticType>([
  "location", "date-range", "party", "preference-set", "money", "identifier",
  "string", "text", "time-slot", "quantity", "enum", "date", "datetime",
]);

function lowerType(raw: Record<string, unknown>): IRType {
  if (typeof raw.collection === "string") return { kind: "collection", of: raw.collection };
  if (typeof raw.ref === "string") return { kind: "resource", name: raw.ref };
  if (typeof raw.type === "string") {
    if (SEMANTIC_TYPES.has(raw.type as SemanticType)) {
      const t: IRType = { kind: "scalar", semantic: raw.type as SemanticType };
      if (Array.isArray(raw.values)) t.values = raw.values as string[];
      return t;
    }
    // A capitalized/unknown `type:` is a resource-typed field (e.g. `type: Account`).
    return { kind: "resource", name: raw.type };
  }
  return { kind: "scalar", semantic: "string" };
}

function lowerFields(map: Record<string, unknown> | undefined): IRField[] {
  if (!map) return [];
  return Object.entries(map).map(([name, value]) => {
    const raw = (value ?? {}) as Record<string, unknown>;
    const field: IRField = {
      name,
      required: typeof raw.required === "boolean" ? raw.required : true,
      type: lowerType(raw),
    };
    if (typeof raw.description === "string") field.description = raw.description;
    return field;
  });
}

/**
 * Narrow a shape-valid binding connector to a typed IRConnector by its `type`
 * discriminant. No unchecked cast: `rest` fields are copied explicitly; other
 * known protocols carry only `{ type }` (no fabricated `rest` block); an
 * unknown `type` is dropped (returns undefined) so it never reaches IR.
 */
function lowerConnector(raw: Record<string, unknown>): IRConnector | undefined {
  const type = raw.type;
  if (typeof type !== "string" || !CONNECTOR_TYPES.has(type as IRConnector["type"])) return undefined;
  if (type !== "rest") return { type: type as IRConnector["type"] };

  const connector: IRConnector = { type: "rest" };
  const rest = raw.rest;
  if (rest && typeof rest === "object") {
    const r = rest as Record<string, unknown>;
    const irRest: IRRestConnector = {
      method: typeof r.method === "string" ? r.method : "",
      path: typeof r.path === "string" ? r.path : "",
    };
    if (typeof r.baseUrl === "string") irRest.baseUrl = r.baseUrl;
    if (r.headers && typeof r.headers === "object") irRest.headers = r.headers as Record<string, string>;
    if (typeof r.body === "string") irRest.body = r.body;
    connector.rest = irRest;
  }
  return connector;
}

export function compile(model: LoadResult): IR {
  const connectorByCap = new Map<string, IRConnector>();
  for (const b of model.bindings) {
    const connector = lowerConnector(b.binding.connector);
    if (connector) connectorByCap.set(b.binding.capabilityId, connector);
  }

  const tools: IRTool[] = model.capabilityDocs.map((d: CapabilityDoc) => {
    const c = d.capability;
    const tool: IRTool = {
      id: c.id,
      description: c.description,
      effect: c.effect,
      provider: c.provider ?? "",
      policies: c.policies ?? [],
      input: lowerFields(c.input),
      output: lowerFields(c.output),
    };
    const connector = connectorByCap.get(c.id);
    if (connector) tool.connector = connector;
    return tool;
  });

  return {
    version: "0",
    company: { id: model.capabilities?.company.id ?? "", name: model.capabilities?.company.name },
    tools,
  };
}
