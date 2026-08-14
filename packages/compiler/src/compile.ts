// @archstone/compiler — Compiler (#4)
//
// Lowers the shape-valid, semantically-resolved model (from #2/#3) into IR.
// Pure: model -> IR. No MCP SDK, no HTTP. Assumes the model passed the semantic
// pass (validateSemantics); it builds what it can regardless.

import type { LoadResult, CapabilityDoc, PolicyDoc } from "@archstone/schema";
import { SEMANTIC_TYPES, LIFECYCLE_STATES, type IR, type IRTool, type IRField, type IRType, type IRConnector, type IRRestConnector, type IRResourceRegistry, type IRResponseMapping, type IRFieldMapping, type IRContract, type IRPolicyRule, type Lifecycle, type SemanticType } from "./ir";
import { domainOf, resolveResourceName, resourceIndex } from "./resolve";

const CONNECTOR_TYPES = new Set<IRConnector["type"]>(["rest", "graphql", "grpc", "sql", "soap"]);

/** Canonicalize a resource name to its resolved qualified form; unresolved names pass
 *  through unchanged (a safe floor — validation (#3) has already flagged them as errors). */
type Canonicalize = (ref: string) => string;

function lowerType(raw: Record<string, unknown>, canon: Canonicalize): IRType {
  if (typeof raw.collection === "string") return { kind: "collection", of: canon(raw.collection) };
  if (typeof raw.ref === "string") return { kind: "resource", name: canon(raw.ref), identity: true };
  if (typeof raw.type === "string") {
    if (SEMANTIC_TYPES.has(raw.type as SemanticType)) {
      const t: IRType = { kind: "scalar", semantic: raw.type as SemanticType };
      if (Array.isArray(raw.values)) t.values = raw.values as string[];
      return t;
    }
    // A capitalized/unknown `type:` is a resource-typed field (e.g. `type: Account`).
    return { kind: "resource", name: canon(raw.type) };
  }
  return { kind: "scalar", semantic: "string" };
}

function lowerFields(map: Record<string, unknown> | undefined, canon: Canonicalize): IRField[] {
  if (!map) return [];
  return Object.entries(map).map(([name, value]) => {
    const raw = (value ?? {}) as Record<string, unknown>;
    const field: IRField = {
      name,
      required: typeof raw.required === "boolean" ? raw.required : true,
      type: lowerType(raw, canon),
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
    if (r.query && typeof r.query === "object") irRest.query = r.query as Record<string, string>;
    connector.rest = irRest;
  }
  return connector;
}

/** The output field the mapped resource lands under (D-7): the single output field whose
 *  type references the mapped resource. None → undefined (validator has flagged the mismatch;
 *  we drop the mapping rather than bind it wrong — a safe floor). */
function outputFieldFor(resource: string, output: IRField[]): string | undefined {
  const match = output.find(
    (f) =>
      (f.type.kind === "collection" && f.type.of === resource) ||
      (f.type.kind === "resource" && f.type.name === resource && !f.type.identity),
  );
  return match?.name;
}

/** Lower a shape-valid binding `response:` to a neutral IRResponseMapping. Canonicalizes the
 *  resource name and binds it to its output field; the required set is NOT copied here (the
 *  runtime reads it from the resource registry, so mapping + outputSchema cannot disagree). */
function lowerResponse(raw: Record<string, unknown>, canon: Canonicalize, output: IRField[]): IRResponseMapping | undefined {
  if (typeof raw.resource !== "string") return undefined;
  const resource = canon(raw.resource);
  const field = outputFieldFor(resource, output);
  if (!field) return undefined; // no output field references this resource — cannot bind (validator errored)

  const map = (raw.map ?? {}) as Record<string, unknown>;
  const fields: IRFieldMapping[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (typeof value === "string") {
      fields.push({ name, path: value });
    } else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (typeof v.path === "string") {
        const fm: IRFieldMapping = { name, path: v.path };
        if (v.required === false) fm.requiredOverride = false;
        fields.push(fm);
      }
    }
  }

  const mapping: IRResponseMapping = { resource, field, fields };
  if (typeof raw.collection === "string") mapping.collection = raw.collection;
  return mapping;
}

/** Lower a shape-valid binding `contract:` to a neutral IRContract (ADD-18). No fs, no hashing. */
function lowerContract(raw: Record<string, unknown>): IRContract | undefined {
  if (typeof raw.fingerprint !== "string") return undefined;
  const probe = (raw.probe ?? {}) as Record<string, unknown>;
  if (typeof probe.fixture !== "string") return undefined;
  return { fingerprint: raw.fingerprint, probeFixture: probe.fixture };
}

/**
 * Does a Policy document's scope land on this capability? (#43 / ADD-43 D-1.)
 *
 * Exported and shared with `validate.ts` deliberately: the semantic pass's disjoint-`allow`
 * warning (BR-46) has to reason about the same attachment set the lowering below produces, and
 * two independent copies of "which policies apply here" is exactly the drift #43 exists to
 * remove. Resolution only — it decides nothing about whether a call is permitted.
 *
 * A policy with no `scope` matches nothing (the semantic pass reports it as an error; here it
 * is the safe floor this file's header promises — "builds what it can regardless").
 */
export function policyScopesCapability(
  meta: PolicyDoc["metadata"],
  capabilityId: string,
  provider: string,
): boolean {
  if (meta.scope === "capability") return meta.capabilityId !== undefined && meta.capabilityId === capabilityId;
  if (meta.scope === "provider") return meta.provider !== undefined && meta.provider === provider;
  return false;
}

/**
 * Lower every policy document scoped onto one capability into neutral `IRPolicyRule`s.
 *
 * Copies `allow`/`deny` VERBATIM and evaluates nothing (BR-7). `constraints` is not copied — by
 * explicit field selection rather than by a delete, the same "no unchecked cast" discipline
 * `lowerConnector` uses. That is ADD-43 D-3's strip: an empty `constraints: {}` is legal to
 * author and simply never reaches the IR, so the evaluator's fail-closed unknown-key branch
 * needs no exception for it (a non-empty one never compiles at all, D-2).
 *
 * `rateLimit` (#45 / ADD-45 D-1) IS copied — verbatim, `{ maxInvocations, windowSeconds }` —
 * once validate.ts's `policy-ratelimit-invalid` check has already refused anything incomplete,
 * so lowering never has to guess a default for a missing half of the pair.
 */
function lowerPolicyRules(docs: PolicyDoc[], capabilityId: string, provider: string): IRPolicyRule[] | undefined {
  const rules: IRPolicyRule[] = [];
  for (const p of docs) {
    if (!policyScopesCapability(p.metadata, capabilityId, provider)) continue;
    const rule: IRPolicyRule = { id: p.metadata.id };
    if (Array.isArray(p.spec?.allow)) rule.allow = [...p.spec.allow];
    if (Array.isArray(p.spec?.deny)) rule.deny = [...p.spec.deny];
    const rl = p.spec?.rateLimit as { maxInvocations?: unknown; windowSeconds?: unknown } | undefined;
    if (
      rl &&
      typeof rl.maxInvocations === "number" &&
      Number.isInteger(rl.maxInvocations) &&
      rl.maxInvocations >= 1 &&
      typeof rl.windowSeconds === "number" &&
      Number.isInteger(rl.windowSeconds) &&
      rl.windowSeconds >= 1
    ) {
      rule.rateLimit = { maxInvocations: rl.maxInvocations, windowSeconds: rl.windowSeconds };
    }
    rules.push(rule);
  }
  return rules.length > 0 ? rules : undefined;
}

/** Read a capability's authored `lifecycle`, defaulting to "stable" when absent or not a
 *  recognized state (same defensive-default style as `raw.required`, ADD-24 D-4). */
function lowerLifecycle(raw: unknown): Lifecycle {
  return typeof raw === "string" && LIFECYCLE_STATES.has(raw as Lifecycle) ? (raw as Lifecycle) : "stable";
}

export function compile(model: LoadResult): IR {
  const connectorByCap = new Map<string, IRConnector>();
  const responseByCap = new Map<string, Record<string, unknown>>();
  const contractByCap = new Map<string, Record<string, unknown>>();
  for (const b of model.bindings) {
    const connector = lowerConnector(b.binding.connector);
    if (connector) connectorByCap.set(b.binding.capabilityId, connector);
    if (b.binding.response) responseByCap.set(b.binding.capabilityId, b.binding.response);
    if (b.binding.contract) contractByCap.set(b.binding.capabilityId, b.binding.contract);
  }

  // Resolve every resource reference (#3 already checked; here we canonicalize, D-2/P-7)
  // so registry keys and IRType names are the same qualified form the emitter reads.
  const index = resourceIndex(model.resourceDocs);
  const canonFor = (domain: string): Canonicalize => (ref) => {
    const res = resolveResourceName(ref, domain, index);
    return res.ok ? res.canonical : ref; // unresolved names pass through (safe floor)
  };

  // Neutral resource registry: canonical name → lowered field list. No JSON Schema here.
  const resources: IRResourceRegistry = {};
  for (const r of model.resourceDocs) {
    resources[r.resource.name] = lowerFields(r.resource.fields, canonFor(domainOf(r.resource.name)));
  }

  const tools: IRTool[] = model.capabilityDocs.map((d: CapabilityDoc) => {
    const c = d.capability;
    const canon = canonFor(domainOf(c.id));
    const tool: IRTool = {
      id: c.id,
      description: c.description,
      effect: c.effect,
      provider: c.provider ?? "",
      policies: c.policies ?? [],
      lifecycle: lowerLifecycle(c.lifecycle),
      input: lowerFields(c.input, canon),
      output: lowerFields(c.output, canon),
    };
    const policyRules = lowerPolicyRules(model.policyDocs ?? [], c.id, tool.provider);
    if (policyRules) tool.policyRules = policyRules;
    const connector = connectorByCap.get(c.id);
    if (connector) tool.connector = connector;
    const rawResponse = responseByCap.get(c.id);
    if (rawResponse) {
      const response = lowerResponse(rawResponse, canon, tool.output);
      if (response) tool.response = response;
    }
    const rawContract = contractByCap.get(c.id);
    if (rawContract) {
      const contract = lowerContract(rawContract);
      if (contract) tool.contract = contract;
    }
    return tool;
  });

  return {
    version: "0",
    company: { id: model.capabilities?.company.id ?? "", name: model.capabilities?.company.name },
    tools,
    resources,
  };
}
