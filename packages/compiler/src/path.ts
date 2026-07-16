// @archstone/compiler — JSONPath helper (ADD-12).
//
// The single place `jsonpath-plus` is touched. `parsePath` is the COMPILE-TIME
// syntax check (used by the validator so a malformed path is a binding error, not
// a silent runtime null); `evalPath` is the RUNTIME evaluator (used by the response
// mapper). One dependency location — the runtime imports `evalPath` from here, so
// jsonpath-plus never becomes a second, divergent evaluator elsewhere. Neutral:
// no MCP, no HTTP.

import { JSONPath } from "jsonpath-plus";

export type PathParse = { ok: true } | { ok: false; error: string };

/**
 * Compile-time sanity check for a JSONPath string. `jsonpath-plus` ships no strict
 * parser (`toPathArray` never throws — it tokenizes anything, and eval silently returns
 * no matches), so a bad path would otherwise fail as a *runtime* VIOLATION, not a build
 * error. This does a best-effort STRUCTURAL check — non-empty, anchored at `$`/`@`, and
 * balanced `()`/`[]` — which catches the gross authoring mistakes (`$.[`, `$.a[?(@.x`,
 * `foo.bar`); deeper semantic validity still surfaces at eval as an empty match set.
 */
export function parsePath(path: string): PathParse {
  const p = path.trim();
  if (p === "") return { ok: false, error: "empty path" };
  if (!p.startsWith("$") && !p.startsWith("@")) {
    return { ok: false, error: "must start with '$' (root) or '@' (current node)" };
  }
  let round = 0;
  let square = 0;
  for (const ch of p) {
    if (ch === "(") round++;
    else if (ch === ")") round--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    if (round < 0 || square < 0) return { ok: false, error: `unbalanced '${ch}'` };
  }
  if (round !== 0 || square !== 0) return { ok: false, error: "unbalanced brackets/parentheses" };
  // Defensive: honour any future jsonpath-plus version that *does* throw on a bad path.
  try {
    JSONPath.toPathArray(p);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

/** Evaluate a (validated) JSONPath against a JSON value, always returning the match
 *  list (empty = no match). `wrap: true` keeps the return shape uniform for the mapper. */
export function evalPath(json: unknown, path: string): unknown[] {
  // jsonpath-plus types `json` as a concrete JSON value; a mapper feeds it arbitrary
  // provider bodies, so we widen at the boundary. `wrap: true` yields the match array.
  const result = JSONPath({ path, json: json as never, wrap: true }) as unknown;
  return Array.isArray(result) ? result : [];
}
