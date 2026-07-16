// @archstone/compiler — Semantic Validator (#3)
//
// Runs on the Semantic Model (the loaded, shape-valid manifest from #2), not on
// YAML. Semantic-type validity is already enforced structurally by cdl.schema.json
// in #2, so this pass is strictly CROSS-FILE: does the provider resolve? do
// declared IDs match files? do bindings resolve? Errors block; warnings inform.

import type { LoadResult, CapabilityDoc } from "@archstone/schema";
import { domainOf, referencedResourceName, resolveResourceName, resourceIndex } from "./resolve";
import { parsePath } from "./path";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
}

export function validateSemantics(model: LoadResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const { capabilities: caps, capabilityDocs: docs, bindings, resourceDocs } = model;

  // Index capability docs by id (and catch duplicates).
  const byId = new Map<string, CapabilityDoc>();
  for (const d of docs) {
    const id = d.capability.id;
    const existing = byId.get(id);
    if (existing) {
      diags.push({
        severity: "error",
        code: "duplicate-capability",
        message: `capability '${id}' is defined in more than one file (${existing.file}, ${d.file})`,
      });
    } else {
      byId.set(id, d);
    }
  }

  const providers = new Set(caps?.providers ?? []);
  const declared = new Set(caps?.capabilities ?? []);

  // 1. Provider resolution — every capability.provider must exist in capabilities.yaml.
  for (const d of docs) {
    const p = d.capability.provider;
    if (!p) {
      diags.push({ severity: "error", code: "missing-provider", message: `capability '${d.capability.id}' (${d.file}) declares no provider` });
    } else if (caps && !providers.has(p)) {
      diags.push({ severity: "error", code: "unknown-provider", message: `capability '${d.capability.id}' references provider '${p}' not listed in capabilities.yaml` });
    }
  }

  // 2. Declared <-> files consistency (only meaningful when capabilities.yaml loaded).
  if (caps) {
    for (const id of declared) {
      if (!byId.has(id)) {
        diags.push({ severity: "error", code: "declared-without-file", message: `capabilities.yaml declares '${id}' but no *.capability.yaml defines it` });
      }
    }
    for (const d of docs) {
      if (!declared.has(d.capability.id)) {
        diags.push({ severity: "error", code: "file-not-declared", message: `capability '${d.capability.id}' (${d.file}) is not declared in capabilities.yaml` });
      }
    }
    const usedProviders = new Set(docs.map((d) => d.capability.provider).filter((p): p is string => Boolean(p)));
    for (const p of providers) {
      if (!usedProviders.has(p)) {
        diags.push({ severity: "warning", code: "unused-provider", message: `provider '${p}' is declared but no capability uses it` });
      }
    }
  }

  // 3. Binding resolution + capability-without-binding (NF-1).
  const boundIds = new Set<string>();
  for (const b of bindings) {
    const cid = b.binding.capabilityId;
    boundIds.add(cid);
    if (!byId.has(cid)) {
      diags.push({ severity: "error", code: "binding-without-capability", message: `binding ${b.file} references capability '${cid}' which is not defined` });
    }
  }
  for (const d of docs) {
    if (!boundIds.has(d.capability.id)) {
      diags.push({ severity: "warning", code: "capability-without-binding", message: `capability '${d.capability.id}' has no binding — not invocable until one is added` });
    }
  }

  // 4. Resource resolution (P-7) — every `ref`/`collection`/resource-typed name in a
  // capability's input/output AND in a resource's fields (transitively, since every
  // resource's fields are checked here) must resolve to a loaded resource.
  const index = resourceIndex(resourceDocs);

  // Duplicate resource definitions (same canonical name in more than one file) → warn.
  const seen = new Map<string, string>();
  for (const r of resourceDocs) {
    const name = r.resource.name;
    const first = seen.get(name);
    if (first) {
      diags.push({ severity: "warning", code: "duplicate-resource", message: `resource '${name}' is defined in more than one file (${first}, ${r.file})` });
    } else {
      seen.set(name, r.file);
    }
  }

  const checkFields = (fields: Record<string, unknown> | undefined, domain: string, where: string) => {
    if (!fields) return;
    for (const [fieldName, raw] of Object.entries(fields)) {
      const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
      if (!ref) continue;
      const res = resolveResourceName(ref, domain, index);
      if (res.ok) continue;
      const detail =
        res.reason === "ambiguous"
          ? `resource '${ref}' is ambiguous — it matches both ${res.candidates[0]} and ${res.candidates[1]}; qualify it`
          : `resource '${ref}' is not defined by any *.resource.yaml`;
      diags.push({ severity: "error", code: "unknown-resource", message: `${where} field '${fieldName}' references ${detail}` });
    }
  };

  for (const d of docs) {
    const domain = domainOf(d.capability.id);
    checkFields(d.capability.input, domain, `capability '${d.capability.id}' (${d.file}) input`);
    checkFields(d.capability.output, domain, `capability '${d.capability.id}' (${d.file}) output`);
  }
  for (const r of resourceDocs) {
    checkFields(r.resource.fields, domainOf(r.resource.name), `resource '${r.resource.name}' (${r.file})`);
  }

  // 5. Response-mapping resolution (ADD-12) — for each binding `response:`: the resource
  // resolves (P-7); every `map` key is a real field of it; every path parses; and the bound
  // capability has exactly one output field referencing that resource (D-7 output binding).
  const fieldsByResource = new Map<string, Set<string>>();
  for (const r of resourceDocs) {
    fieldsByResource.set(r.resource.name, new Set(Object.keys(r.resource.fields ?? {})));
  }

  for (const b of bindings) {
    const resp = b.binding.response;
    if (!resp) continue;
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    if (!cap) continue; // binding-without-capability already reported above
    const domain = domainOf(cid);
    const at = `binding ${b.file} response`;

    const rawResource = resp.resource;
    if (typeof rawResource !== "string") continue; // shape-guaranteed by schema; defensive
    const resolved = resolveResourceName(rawResource, domain, index);
    if (!resolved.ok) {
      const detail =
        resolved.reason === "ambiguous"
          ? `is ambiguous — it matches both ${resolved.candidates[0]} and ${resolved.candidates[1]}; qualify it`
          : `is not defined by any *.resource.yaml`;
      diags.push({ severity: "error", code: "unknown-response-resource", message: `${at} maps to resource '${rawResource}' which ${detail}` });
      continue;
    }
    const canonical = resolved.canonical;
    const resourceFields = fieldsByResource.get(canonical);

    // Every map key must be a field of the resolved resource; every path must parse.
    const map = (resp.map ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(map)) {
      if (resourceFields && !resourceFields.has(key)) {
        diags.push({ severity: "error", code: "unknown-response-field", message: `${at} maps '${key}', not a field of resource '${canonical}'` });
      }
      const path = typeof value === "string" ? value : typeof (value as Record<string, unknown>)?.path === "string" ? (value as Record<string, string>).path : undefined;
      if (typeof path === "string") {
        const p = parsePath(path);
        if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} field '${key}' has an invalid JSONPath '${path}': ${p.error}` });
      }
    }
    if (typeof resp.collection === "string") {
      const p = parsePath(resp.collection);
      if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} collection has an invalid JSONPath '${resp.collection}': ${p.error}` });
    }

    // D-7: exactly one output field must reference the mapped resource, so the mapped
    // result has one unambiguous home in the tool's output (structuredContent = outputSchema).
    const targets = Object.entries((cap.capability.output ?? {}) as Record<string, unknown>).filter(([, raw]) => {
      const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
      if (!ref) return false;
      const r = resolveResourceName(ref, domain, index);
      return r.ok && r.canonical === canonical;
    });
    if (targets.length !== 1) {
      const detail = targets.length === 0 ? `no output field references resource '${canonical}'` : `${targets.length} output fields reference resource '${canonical}' (need exactly one)`;
      diags.push({ severity: "error", code: "response-output-mismatch", message: `${at}: ${detail}` });
    }
  }

  return diags;
}
