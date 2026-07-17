// @archstone/runtime — Capability Registry (#5)
//
// The product kernel: capabilities queryable at runtime, indexed over the IR.
// File-backed (no DB) — the IR is derived from manifests on disk. The MCP emitter
// (#7) consumes this to list and resolve tools.
//
// `Registry` (index-only) moved to @archstone/emitter-support (ADD-0008 #27) — re-exported
// here for back-compat so nothing downstream breaks. This file keeps the fs-touching
// pipeline (`buildRegistry`), which is why the /http subpath (http.ts) never imports it.

import { load, type LoadResult, type LoadIssue } from "@archstone/schema";
import { validateSemantics, compile, type Diagnostic } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";

export { Registry } from "@archstone/emitter-support";

export interface BuildResult {
  ok: boolean;
  registry?: Registry;
  issues: LoadIssue[];
  diagnostics: Diagnostic[];
}

/**
 * File-backed pipeline: load (#2) → semantic-validate (#3) → compile (#4) → Registry (#5).
 * `registry` is present only when shapes are valid and there are no semantic errors.
 */
export function buildRegistry(dir: string): BuildResult {
  const model: LoadResult = load(dir);
  const diagnostics = validateSemantics(model);
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const ok = model.ok && !hasErrors;
  return {
    ok,
    registry: ok ? new Registry(compile(model)) : undefined,
    issues: model.issues,
    diagnostics,
  };
}
