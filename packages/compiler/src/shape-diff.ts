// @archstone/compiler — Response-shape diff (ADD-114).
//
// Pure set arithmetic over two `ShapeMap`s: which paths the provider gained, lost, or
// retyped since the contract was recorded. No I/O, no MCP, no HTTP — it lives beside the
// fingerprint it exists to explain (ADD-114 §1), and `verify` composes it.
//
// This NEVER decides health. ADD-18 D-2's fingerprint remains the sole authority for
// green/yellow/red; a diff is narrative (ADD-114 D-2).

import type { JsonType, ShapeMap } from "./fingerprint";

export interface ShapeAddition {
  path: string;
  type: JsonType;
}

export interface ShapeRetype {
  path: string;
  from: JsonType;
  to: JsonType;
}

/** What moved between a recorded shape and a live one. Every list is sorted by path, so
 *  two runs over the same pair of shapes produce identical reports. */
export interface ShapeDiff {
  added: ShapeAddition[];
  removed: ShapeAddition[];
  retyped: ShapeRetype[];
}

function byPath<T extends { path: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The array base path an element-shape path hangs off, e.g. `$.items[].code` -> `$.items[]`;
 *  `undefined` for a path that is not itself inside an array (#83, ADD-12 §8.3). Only the
 *  first `[]` matters — nested arrays-of-arrays are out of scope, same as `describeShape`'s own
 *  single-element-per-array traversal. */
function arrayBaseOf(path: string): string | undefined {
  const i = path.indexOf("[]");
  return i === -1 ? undefined : path.slice(0, i + 2);
}

/**
 * Compare a recorded response shape against a live one.
 *
 * A path present in both with the same type does not appear in the result — the diff carries
 * only what changed, so an unchanged contract produces three empty lists rather than a full
 * inventory the caller has to filter.
 *
 * #83 (ADD-12 §8.3): an array ELEMENT shape (a `[]`-bearing path) is treated as observed-so-far,
 * never as an exhaustive replacement of the prior run — `describeShape` records only one
 * element's shape per run (the SAME single-element traversal `fingerprintShape` uses, frozen —
 * see `fingerprint.ts`), so a data-dependent collection legitimately shows a different element
 * path on different runs without that being drift. Two cases are NOT reported as drift on their
 * own: an array that goes from populated to empty (its element paths are absent this run only
 * because there is nothing to shape, not because the shape was lost — suppressed whenever the
 * array's own base path is still present live); and an array whose only PRIOR observation was
 * itself empty, now populated for the first time (there was no prior element shape to compare
 * against — filling in an unknown is not a retype, and not reported as added). A genuinely new
 * element path recorded alongside an ALREADY-known one for the same array (e.g. a declared #81
 * error-row variant appearing for the first time in a collection that has only ever shown
 * success rows) still reports as `added` — it is new information, distinguishable from "this
 * array was never populated before" by that already-known sibling, and never folded into
 * `retyped` (it is a different path, not a retyped one).
 */
export function diffShape(recorded: ShapeMap, live: ShapeMap): ShapeDiff {
  const added: ShapeAddition[] = [];
  const removed: ShapeAddition[] = [];
  const retyped: ShapeRetype[] = [];

  // Was this array (named by its OWN item-shape path, e.g. `$.stays[]`) populated at all in the
  // recorded/live shape? `describeShape` pushes that path — and everything under it — only when
  // the array has ≥1 element (see `shapeEntries`), so its presence alone answers the question,
  // without walking every sub-path.
  const populated = (shape: ShapeMap, base: string) => shape[base] !== undefined;

  for (const [path, type] of Object.entries(live)) {
    const before = recorded[path];
    if (before === undefined) {
      const base = arrayBaseOf(path);
      // Scenario 2: this array's only PRIOR observation was empty — there was no prior element
      // shape to compare against, so filling one in for the first time is not drift, whether
      // `path` is the item's own shape or a field under it.
      if (base && !populated(recorded, base)) continue;
      added.push({ path, type });
    } else if (before !== type) {
      retyped.push({ path, from: before, to: type });
    }
  }

  for (const [path, type] of Object.entries(recorded)) {
    if (live[path] === undefined) {
      const base = arrayBaseOf(path);
      // Scenario 1: the array is empty THIS run (no `[]`-suffixed entries survive at all) —
      // its previously-recorded element shape is retained conceptually, not lost, so nothing
      // under `base` (including `base` itself) is reported as removed. When the array is still
      // populated live (`populated(live, base)` true), a path missing from it is a real,
      // reportable removal — a field genuinely dropped from the row shape.
      if (base && !populated(live, base)) continue;
      removed.push({ path, type });
    }
  }

  return { added: byPath(added), removed: byPath(removed), retyped: byPath(retyped) };
}

/** True when a diff has anything to report. */
export function hasShapeDrift(diff: ShapeDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.retyped.length > 0;
}

/**
 * The operator-facing sentence for a diff — one spelling, so the human report and any future
 * consumer never describe the same comparison differently (the ADD-19/`contractViolationMessage`
 * precedent).
 */
export function shapeDriftSummary(diff: ShapeDiff): string {
  const parts: string[] = [];
  const fmt = (e: ShapeAddition) => `${e.path} (${e.type})`;
  if (diff.added.length > 0) parts.push(`gained ${diff.added.length} field(s): ${diff.added.map(fmt).join(", ")}`);
  if (diff.removed.length > 0) parts.push(`lost ${diff.removed.length} field(s): ${diff.removed.map(fmt).join(", ")}`);
  if (diff.retyped.length > 0) {
    parts.push(`retyped ${diff.retyped.length} field(s): ${diff.retyped.map((e) => `${e.path} (${e.from} → ${e.to})`).join(", ")}`);
  }
  return parts.join("; ");
}
