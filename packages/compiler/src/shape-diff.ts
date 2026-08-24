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

/**
 * Compare a recorded response shape against a live one.
 *
 * A path present in both with the same type does not appear in the result — the diff carries
 * only what changed, so an unchanged contract produces three empty lists rather than a full
 * inventory the caller has to filter.
 */
export function diffShape(recorded: ShapeMap, live: ShapeMap): ShapeDiff {
  const added: ShapeAddition[] = [];
  const removed: ShapeAddition[] = [];
  const retyped: ShapeRetype[] = [];

  for (const [path, type] of Object.entries(live)) {
    const before = recorded[path];
    if (before === undefined) added.push({ path, type });
    else if (before !== type) retyped.push({ path, from: before, to: type });
  }

  for (const [path, type] of Object.entries(recorded)) {
    if (live[path] === undefined) removed.push({ path, type });
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
