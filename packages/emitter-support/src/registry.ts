// @archstone/emitter-support — IR indexing (Registry)
//
// Index-only: no disk I/O, no @archstone/schema. Moved out of @archstone/runtime's
// registry.ts (ADD-0008 #27) — `buildRegistry`, the file-backed pipeline
// (load → validateSemantics → compile → Registry), stays in @archstone/runtime, which
// re-exports this class for back-compat.
//
// ADD-30 (#30): a second index, `byName`, keyed by the sanitized tool name (`toolName()`,
// same lowering `buildToolDefs`/`toolDefinitions` already use to advertise a name) — built
// once here, over invocable (`.connector`-bearing) tools only, so `getCapability` resolves
// both the raw CDL id (`byId`) and the sanitized name `tools()`/`buildToolDefs` hand an
// agent. Two distinct capability ids that resolve to the identical name are recorded in
// `toolNameCollisions` rather than one silently overwriting the other; a collided name
// resolves to `undefined` from `getCapability` (defense in depth — D-2/BR-6) even if a
// caller skips the boundary-level gate (`fromIR`/`buildRegistry`, which refuse to proceed
// at all when this list is non-empty).
//
// D-1 ("byId first, always authoritative") holds for every id containing a character
// `toolName()` rewrites (e.g. any dotted CDL id — the sanitized-name index never contains
// such a string, since toolName() strips exactly those characters), which is the
// overwhelming common case. The one narrow exception, spelled out by the ADD's own worked
// example: a raw id that is ALREADY shaped like a sanitized name (no character toolName()
// rewrites — e.g. "tourism_search") can collide with ANOTHER capability's sanitized form
// (e.g. bound "tourism.search" also sanitizes to "tourism_search"). Left unchecked, that
// would let a raw-id lookup silently shadow the capability `tools()` actually advertised
// under that name — exactly the silent misroute BR-6 forbids — so this construction also
// treats that case as ambiguous, even though it costs the shadowed capability its own
// otherwise-valid raw-id lookup. This one case is the reason `byId` is cross-checked
// while building `byName` below, not just `byName` against itself.

import type { IR, IRTool } from "@archstone/compiler";
import { toolName } from "./lowering";

export interface ToolNameCollision {
  /** The sanitized name (`toolName()` output) two or more capabilities share. */
  name: string;
  /** The colliding capabilities' raw ids (deduped, insertion order). */
  ids: string[];
}

/** One invocable capability, paired with the sanitized name it's advertised under —
 *  the shared surface `buildToolDefs` (@archstone/agent) and `toolDefinitions`
 *  (@archstone/runtime) both read instead of hand-rolling their own filter+map (ADD-30 D-3). */
export interface NamedTool {
  name: string;
  tool: IRTool;
}

export class Registry {
  private readonly byId: Map<string, IRTool>;
  private readonly byName: Map<string, IRTool>; // never holds an ambiguous name — see ambiguousNames
  private readonly ambiguousNames: Set<string>;
  private readonly invocable: NamedTool[];

  readonly toolNameCollisions: ReadonlyArray<ToolNameCollision>;

  constructor(public readonly ir: IR) {
    this.byId = new Map(ir.tools.map((t) => [t.id, t]));

    this.byName = new Map();
    this.ambiguousNames = new Set();
    const collisionIds = new Map<string, Set<string>>();
    const invocable: NamedTool[] = [];

    const markAmbiguous = (name: string, ids: Iterable<string>): void => {
      this.ambiguousNames.add(name);
      this.byName.delete(name);
      const set = collisionIds.get(name) ?? new Set<string>();
      for (const id of ids) set.add(id);
      collisionIds.set(name, set);
    };

    for (const t of ir.tools) {
      if (!t.connector) continue; // unbound — no advertised name to index (BR-5/EC-3)
      const name = toolName(t.id);

      if (this.ambiguousNames.has(name)) {
        markAmbiguous(name, [t.id]);
        continue;
      }

      // A different capability may already own this exact string as its raw id (byId —
      // see header comment) or as a previously seen sanitized name (byName).
      const idOwner = this.byId.get(name);
      const nameOwner = this.byName.get(name);
      const others = new Set<string>();
      if (idOwner && idOwner.id !== t.id) others.add(idOwner.id);
      if (nameOwner && nameOwner.id !== t.id) others.add(nameOwner.id);

      if (others.size > 0) {
        others.add(t.id);
        markAmbiguous(name, others);
      } else {
        this.byName.set(name, t);
        invocable.push({ name, tool: t });
      }
    }

    this.toolNameCollisions = [...collisionIds.entries()].map(([name, ids]) => ({ name, ids: [...ids] }));
    // A name that turned out ambiguous is never advertised as invocable — advertising a
    // name that can never resolve would itself be a silent-misroute risk (BR-6).
    this.invocable = invocable.filter((nt) => !this.ambiguousNames.has(nt.name));
  }

  /** All capabilities (bound or not), for MCP tool listing / reporting. */
  listCapabilities(): IRTool[] {
    return [...this.byId.values()];
  }

  /** Invocable (bound) capabilities paired with their advertised, sanitized tool name —
   *  the single source `buildToolDefs`/`toolDefinitions` read (ADD-30 D-3). */
  invocableTools(): ReadonlyArray<NamedTool> {
    return this.invocable;
  }

  /**
   * Resolve one capability by its raw CDL id OR its advertised (sanitized) tool name.
   * A name flagged in `toolNameCollisions` never resolves here (`undefined`, same as
   * unknown), checked before either index (D-2's defense-in-depth layer — see header
   * comment for why this can, in one narrow case, pre-empt an otherwise-valid raw-id
   * match). Otherwise `byId` resolves the raw CDL id (BR-2) and `byName` resolves the
   * sanitized name `tools()`/`buildToolDefs` handed the caller (BR-1). No case-folding,
   * no re-sanitizing the input (EC-6/EC-7).
   */
  getCapability(idOrName: string): IRTool | undefined {
    if (this.ambiguousNames.has(idOrName)) return undefined;
    const byId = this.byId.get(idOrName);
    if (byId) return byId;
    return this.byName.get(idOrName);
  }

  get size(): number {
    return this.byId.size;
  }
}
