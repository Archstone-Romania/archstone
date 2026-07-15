// @archstone/compiler — Semantic Validator (#3)
//
// Runs on the Semantic Model (the loaded, shape-valid manifest from #2), not on
// YAML. Semantic-type validity is already enforced structurally by cdl.schema.json
// in #2, so this pass is strictly CROSS-FILE: does the provider resolve? do
// declared IDs match files? do bindings resolve? Errors block; warnings inform.

import type { LoadResult, CapabilityDoc } from "@archstone/schema";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
}

export function validateSemantics(model: LoadResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const { capabilities: caps, capabilityDocs: docs, bindings } = model;

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

  return diags;
}
