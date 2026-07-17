// @archstone/emitter-support — IR indexing (Registry)
//
// Index-only: no disk I/O, no @archstone/schema. Moved out of @archstone/runtime's
// registry.ts (ADD-0008 #27) — `buildRegistry`, the file-backed pipeline
// (load → validateSemantics → compile → Registry), stays in @archstone/runtime, which
// re-exports this class for back-compat.

import type { IR, IRTool } from "@archstone/compiler";

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
