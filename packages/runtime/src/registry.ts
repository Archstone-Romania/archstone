// @archstone/runtime — Capability Registry (#5)
//
// The product kernel: capabilities queryable at runtime, indexed over the IR.
// File-backed (no DB) — the IR is derived from manifests on disk. The MCP emitter
// (#7) consumes this to list and resolve tools.

import { load, type LoadResult, type LoadIssue } from "@archstone/schema";
import { validateSemantics, compile, type Diagnostic, type IR, type IRTool } from "@archstone/compiler";

export class Registry {
  private readonly byId: Map<string, IRTool>;

  constructor(public readonly ir: IR) {
    this.byId = new Map(ir.tools.map((t) => [t.id, t]));
  }

  /** All capabilities, for MCP tool listing. */
  listCapabilities(): IRTool[] {
    return [...this.byId.values()];
  }

  /** Resolve one capability by id, for invocation. */
  getCapability(id: string): IRTool | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }
}

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
