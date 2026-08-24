// @archstone/compiler — Response-shape fingerprint (ADD-18) + shape description (ADD-114).
//
// Hashes a JSON value's SHAPE (sorted key paths + value type), not its values, so
// normal data variation (a new hotel, a different price) never reads as drift. Pure,
// no I/O — used by the runtime probe (verify.ts) to compare a live response against
// the fingerprint recorded in a binding's `contract:` block.
//
// ADD-114 exposes the same traversal as a `path -> type` map so `verify` can name WHICH
// paths moved rather than only that the hash did. One traversal feeds both: a second
// implementation would drift from the hash it exists to explain (ADD-114 D-5).

import { createHash } from "node:crypto";

export type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

/** The closed set of `JsonType`, as a value — so a reader validating a recorded shape checks
 *  against the same list the writer produces, not a second copy of it. */
export const JSON_TYPES: readonly JsonType[] = ["string", "number", "boolean", "null", "array", "object"];

/** A recorded response shape: JSONPath-ish key path -> JSON type. Values are never present. */
export type ShapeMap = Record<string, JsonType>;

function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as JsonType;
}

/** Flatten a JSON value into `path -> type` pairs. Arrays are shaped by their
 *  first element only (a homogeneous list's shape doesn't need every index); an empty
 *  array/object still contributes its own path so an empty vs. absent collection differ. */
function shapeEntries(value: unknown, path: string, out: [string, JsonType][]): void {
  const t = jsonType(value);
  out.push([path, t]);
  if (t === "object") {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      shapeEntries((value as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
  } else if (t === "array") {
    const arr = value as unknown[];
    if (arr.length > 0) shapeEntries(arr[0], `${path}[]`, out);
  }
}

/** sha256:<hex> of a sorted `[path, type]` pair list — ADD-18 D-2's canonical form. */
function hashEntries(entries: [string, JsonType][]): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify(sorted);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** sha256:<hex> of a JSON value's shape. Two payloads with the same keys/types but
 *  different values fingerprint identically; a renamed or retyped key changes it.
 *
 *  Computed from the raw entry list, NOT from `describeShape`, so its output is
 *  bit-for-bit what ADD-18 shipped — see `describeShape`'s note on duplicate paths.
 *  Every contract already committed in the wild depends on this not moving. */
export function fingerprintShape(value: unknown): string {
  const entries: [string, JsonType][] = [];
  shapeEntries(value, "$", entries);
  return hashEntries(entries);
}

/**
 * The same traversal as `fingerprintShape`, kept as a `path -> type` map (ADD-114 D-1) so a
 * drift report can name paths and a human can read one in a binding.
 *
 * **Lossy in one pathological case, deliberately.** A JSON key containing a dot collides in
 * this flattened path space — `{"a.b": 1, "a": {"b": 2}}` yields `$.a.b` twice, and a map keeps
 * one. The pair list `fingerprintShape` hashes keeps both, which is why the two are computed
 * from the same traversal but not from each other. The consequence is bounded and fail-safe:
 * for such a payload `fingerprintShapeMap(describeShape(x)) !== fingerprintShape(x)`, so
 * ADD-114 D-3's consistency check reports the recorded shape as stale and suppresses the diff,
 * rather than naming fields from a shape that cannot represent this provider. Health is
 * unaffected in every case — the fingerprint remains the sole authority (D-2).
 */
export function describeShape(value: unknown): ShapeMap {
  const entries: [string, JsonType][] = [];
  shapeEntries(value, "$", entries);
  return Object.fromEntries(entries);
}

/**
 * Re-derive a fingerprint from an already-recorded `ShapeMap`.
 *
 * Exists for ADD-114 D-3: `shape` and `fingerprint` are two records of one observation and can
 * disagree if either is hand-edited, so `verify` re-derives one from the other before trusting
 * a diff. For any payload without the duplicate-path collision above,
 * `fingerprintShapeMap(describeShape(x)) === fingerprintShape(x)`.
 */
export function fingerprintShapeMap(shape: ShapeMap): string {
  return hashEntries(Object.entries(shape) as [string, JsonType][]);
}
