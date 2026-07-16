// @archstone/compiler — Response-shape fingerprint (ADD-18).
//
// Hashes a JSON value's SHAPE (sorted key paths + value type), not its values, so
// normal data variation (a new hotel, a different price) never reads as drift. Pure,
// no I/O — used by the runtime probe (verify.ts) to compare a live response against
// the fingerprint recorded in a binding's `contract:` block.

import { createHash } from "node:crypto";

type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as JsonType;
}

/** Flatten a JSON value into sorted `path -> type` pairs. Arrays are shaped by their
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

/** sha256:<hex> of a JSON value's shape. Two payloads with the same keys/types but
 *  different values fingerprint identically; a renamed or retyped key changes it. */
export function fingerprintShape(value: unknown): string {
  const entries: [string, JsonType][] = [];
  shapeEntries(value, "$", entries);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify(entries);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}
