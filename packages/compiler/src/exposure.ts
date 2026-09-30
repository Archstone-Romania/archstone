// @archstone/compiler — Exposure report (ADD-309 D-6..D-8).
//
// Per capability, three sets read straight off the IR: what a model SENDS (`receives`), what
// it is SHOWN (`exposes`), and what the provider was observed to return that no mapping
// reaches (`withholds`). ADR-0008 as an artifact rather than a promise. Pure — no I/O, no
// clock, no fs; the CLI compiles, renders and exits.
//
// Names and types only. A value never appears here: the only provider-side input is
// `contract.shape` (ADD-114), which carries none.
//
// The report decides nothing (D-7). It does not flag a withheld field, propose adopting one or
// judge a mapping — adoption stays `archstone adopt`'s human act (ADD-117).

import type { JsonType, ShapeMap } from "./fingerprint";
import type { IR, IRResourceRegistry, IRTool, IRType } from "./ir";
import { pathTokens } from "./path";

export interface ExposureInput {
  name: string;
  type: IRType;
  required: boolean;
}

export interface ExposureOutput {
  /** Where the model finds it in the tool's output, e.g. `stays[].name` or `totalMatches`. */
  path: string;
  name: string;
  type: IRType;
  required: boolean;
  /** `response` — filled by a `response.map` entry (or, for an #81 error row, by `onError`'s
   *  map or its same-named-key default); `extract` — by an `extract:` entry; `unmapped` —
   *  declared, but nothing in the binding fills it, so the model never receives a value. */
  via: "response" | "extract" | "unmapped";
}

export interface ExposureWithheld {
  /** A `contract.shape` key, spelled as `describeShape` spells it (`$.stays[].net`). */
  path: string;
  observed: JsonType;
}

export interface ToolExposure {
  capabilityId: string;
  effect: "read" | "write" | "irreversible";
  receives: ExposureInput[];
  exposes: ExposureOutput[];
  /** `"unknown"` iff no `contract.shape` is recorded — never an empty list for that case
   *  (D-6): an empty list means every observed path is reached by a mapping. */
  withholds: ExposureWithheld[] | "unknown";
  /** The observation `withholds` was derived from — present iff `withholds` is a list (R-4:
   *  one recorded response, arrays shaped by their first element, so completeness is exactly
   *  as good as the recorded contract). */
  observation?: { fixture: string; fingerprint: string };
  /** Present iff the binding declares neither `response:` nor `extract:`, so the runtime passes
   *  the provider body through raw (ADD-12 R-3) and nothing is withheld. Stated rather than
   *  left for a reader to infer from an empty `withholds`. */
  passthrough?: true;
}

// ---------------------------------------------------------------------------------------------
// Path composition (ADD-309 §1 row 9, R-6)
//
// A `response.map` path is relative to `response.collection`; a `contract.shape` key is an
// absolute `$.a.b[]`-style path. Both are reduced to steps and compared step by step:
//
//   - a mapping path is tokenised by `pathTokens` — `jsonpath-plus`'s own splitter, the grammar
//     `evalPath` evaluates at runtime — so `$.stays[*]` + `$.name` compose to
//     [stays, *, name] exactly as the runtime's "evaluate the collection, then the field on each
//     item" does;
//   - a shape key is split on `describeShape`'s spelling (`.key` / `[]`, see `shapeEntries`).
//
// A mapping path is a PATTERN (`*`, `..`, indices, filters, unions), a shape key is concrete, so
// matching is a small NFA over the pattern. A shape path is exposed iff it or an ancestor is
// matched by a mapping target; a shape path some target passes THROUGH (`$`, `$.stays`,
// `$.stays[]` for a `$.stays[*].name` target) is structure, neither exposed nor withheld;
// everything else is withheld.
//
// Every uncertainty resolves toward EXPOSED, never toward withheld: a report that called a
// field withheld when a model can see it would be a false statement of ADR-0008. A mapping
// path the grammar cannot place (a parent `^` step, a script) exposes the whole body.
// ---------------------------------------------------------------------------------------------

type ShapeStep = { key: string } | { elem: true };

type PatternStep =
  | { k: "key"; key: string } // a named member
  | { k: "elem" } // `[]` — describeShape's array-element step
  | { k: "index"; key: string } // `[0]` — an array element, or a member literally named "0"
  | { k: "any" } // `*`, a slice, a filter — any single step
  | { k: "desc" } // `..` — zero or more steps
  | { k: "union"; of: PatternStep[] }; // `[a,b]`

/** Split a `describeShape` key into steps. The spelling is `$` followed by `.key` or `[]`; a
 *  key that itself contains `.` is the collision `describeShape` already documents as lossy,
 *  and splits here the same way it collides there. */
export function shapePathSteps(path: string): ShapeStep[] {
  const steps: ShapeStep[] = [];
  let i = path.startsWith("$") ? 1 : 0;
  while (i < path.length) {
    if (path.startsWith("[]", i)) {
      steps.push({ elem: true });
      i += 2;
      continue;
    }
    const start = path[i] === "." ? i + 1 : i;
    let end = start;
    while (end < path.length && path[end] !== "." && !path.startsWith("[]", end)) end++;
    steps.push({ key: path.slice(start, end) });
    i = end;
  }
  return steps;
}

const INDEX = /^-?\d+$/;
const SLICE = /^-?\d*:-?\d*(:-?\d*)?$/;

function tokenStep(token: string): PatternStep | "opaque" {
  if (token === "") return { k: "elem" };
  if (token === "*") return { k: "any" };
  if (token === "..") return { k: "desc" };
  if (INDEX.test(token)) return { k: "index", key: token };
  if (SLICE.test(token)) return { k: "any" };
  if (token.startsWith("?(")) return { k: "any" }; // a filter selects among children, array or object
  if (token.startsWith("(") || token === "^" || token === "~" || token.startsWith("@")) return "opaque";
  if (token.includes(",")) {
    const of: PatternStep[] = [];
    for (const part of token.split(",")) {
      const s = tokenStep(part.trim().replace(/^['"]|['"]$/g, ""));
      // `[a,b.c]` reads the member `b.c`, which a shape spells as two steps — not one step of a
      // union. Rare enough to place as "everything", which is the safe side.
      if (s === "opaque" || (s.k === "key" && s.key.includes("."))) return "opaque";
      of.push(s);
    }
    return { k: "union", of };
  }
  return { k: "key", key: token };
}

/** A mapping path as pattern steps, root anchor dropped. `undefined` when it cannot be placed —
 *  the caller treats that as "exposes everything", never as "exposes nothing". */
function patternSteps(path: string): PatternStep[] | undefined {
  const tokens = pathTokens(path);
  if (!tokens) return undefined;
  const rest = tokens[0] === "$" || tokens[0] === "@" ? tokens.slice(1) : tokens;
  const steps: PatternStep[] = [];
  for (const token of rest) {
    const s = tokenStep(token);
    if (s === "opaque") return undefined;
    // A quoted member containing a dot (`$['a.b']`) is spelled `$.a.b` in a shape — split it
    // the way `describeShape` would, so the two meet.
    if (s.k === "key" && s.key.includes(".")) for (const key of s.key.split(".")) steps.push({ k: "key", key });
    else steps.push(s);
  }
  return steps;
}

function stepMatches(p: PatternStep, s: ShapeStep): boolean {
  switch (p.k) {
    case "key":
      return "key" in s && s.key === p.key;
    case "elem":
      return "elem" in s;
    case "index":
      return "elem" in s || ("key" in s && s.key === p.key);
    case "any":
    case "desc":
      return true;
    case "union":
      return p.of.some((q) => stepMatches(q, s));
  }
}

/** ε-closure: a `..` may consume zero steps. */
function close(pattern: PatternStep[], states: Set<number>): Set<number> {
  for (const i of [...states]) {
    let j = i;
    while (j < pattern.length && pattern[j].k === "desc") states.add(++j);
  }
  return states;
}

type Reach = "exposed" | "structure" | "withheld";

/** Where one shape path stands against one mapping target. */
function reach(pattern: PatternStep[], path: ShapeStep[]): Reach {
  let states = close(pattern, new Set([0]));
  if (states.has(pattern.length)) return "exposed"; // the target is `$` itself, or a prefix of it matched
  for (const step of path) {
    const next = new Set<number>();
    for (const i of states) {
      if (i >= pattern.length) continue;
      const p = pattern[i];
      if (p.k === "desc") next.add(i); // `..` consumes this step and stays; `close` lets it end
      else if (stepMatches(p, step)) next.add(i + 1);
    }
    states = close(pattern, next);
    if (states.has(pattern.length)) return "exposed"; // a prefix of `path` IS the target: path is it or a descendant
    if (states.size === 0) return "withheld";
  }
  return "structure"; // consumed the whole path with the target still ahead of it
}

/**
 * Classify every path of a recorded shape against a set of mapping targets.
 *
 * Structure is decided twice, because a `..` target is an ancestor of everything by pattern
 * alone: a path counts as structure when a target WITHOUT `..` passes through it, or when the
 * shape itself shows an exposed path beneath it. So `$..count` withholds `$.code` rather than
 * waving the whole body through as "something might be under here".
 */
function classify(shape: ShapeMap, targets: PatternStep[][]): ExposureWithheld[] {
  const paths = Object.keys(shape).sort(byString);
  const exposed: string[] = [];
  const passedThrough = new Set<string>();
  for (const path of paths) {
    const steps = shapePathSteps(path);
    let hit = false;
    for (const t of targets) {
      const r = reach(t, steps);
      if (r === "exposed") {
        hit = true;
        break;
      }
      if (r === "structure" && !t.some((s) => s.k === "desc")) passedThrough.add(path);
    }
    if (hit) exposed.push(path);
  }
  const isExposed = new Set(exposed);
  const aboveExposed = (p: string) => exposed.some((q) => q !== p && (p === "$" || q.startsWith(`${p}.`) || q.startsWith(`${p}[]`)));
  return paths
    .filter((p) => !isExposed.has(p) && !passedThrough.has(p) && !aboveExposed(p))
    .map((path) => ({ path, observed: shape[path] }));
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------

/** Every provider path the tool's binding reads into its output, as absolute patterns. */
function mappingTargets(tool: IRTool, resources: IRResourceRegistry): PatternStep[][] {
  const whole: PatternStep[][] = [[]]; // `$` — the entire body
  if (!tool.response && !tool.extract) return tool.connector ? whole : [];

  const targets: PatternStep[][] = [];
  const add = (base: PatternStep[], path: string): boolean => {
    const steps = patternSteps(path);
    if (!steps) return false;
    targets.push([...base, ...steps]);
    return true;
  };

  const r = tool.response;
  if (r) {
    const base = r.collection === undefined ? [] : patternSteps(r.collection);
    if (!base) return whole;
    for (const fm of r.fields) if (!add(base, fm.path)) return whole;
    if (r.onError) {
      // An error row is mapped field by field against `errorResource`: its own `map:` entry, or
      // the same-named key on the item — `applyResponseMapping`'s default, mirrored here.
      const byName = new Map((r.onError.map ?? []).map((fm) => [fm.name, fm.path]));
      for (const f of resources[r.onError.errorResource] ?? []) {
        if (!add(base, byName.get(f.name) ?? `$.${f.name}`)) return whole;
      }
    }
  }
  for (const fm of tool.extract ?? []) if (!add([], fm.path)) return whole;
  return targets;
}

function exposedOutputs(tool: IRTool, resources: IRResourceRegistry): ExposureOutput[] {
  const out: ExposureOutput[] = [];
  const seen = new Set<string>();
  const push = (e: ExposureOutput) => {
    const key = JSON.stringify(e);
    if (!seen.has(key)) out.push(e);
    seen.add(key);
  };
  const r = tool.response;
  const extracted = new Set((tool.extract ?? []).map((fm) => fm.name));

  for (const f of tool.output) {
    if (r && f.name === r.field) {
      // A collection output is an array of rows; `onError` always yields one (it requires a
      // collection), so `[]` exactly when `applyResponseMapping` writes an array.
      const prefix = r.collection !== undefined || r.onError ? `${f.name}[]` : f.name;
      const mapped = new Set(r.fields.map((fm) => fm.name));
      for (const rf of resources[r.resource] ?? []) {
        push({ path: `${prefix}.${rf.name}`, name: rf.name, type: rf.type, required: rf.required, via: mapped.has(rf.name) ? "response" : "unmapped" });
      }
      if (r.onError) {
        for (const ef of resources[r.onError.errorResource] ?? []) {
          push({ path: `${prefix}.${ef.name}`, name: ef.name, type: ef.type, required: ef.required, via: "response" });
        }
      }
      continue;
    }
    push({ path: f.name, name: f.name, type: f.type, required: f.required, via: extracted.has(f.name) ? "extract" : "unmapped" });
  }
  return out.sort((a, b) => byString(a.path, b.path) || byString(a.via, b.via) || byString(JSON.stringify(a.type), JSON.stringify(b.type)));
}

/** What one capability receives, exposes and withholds. Pure. */
export function exposureOf(tool: IRTool, resources: IRResourceRegistry): ToolExposure {
  const exposure: ToolExposure = {
    capabilityId: tool.id,
    effect: tool.effect,
    receives: tool.input.map((f) => ({ name: f.name, type: f.type, required: f.required })).sort((a, b) => byString(a.name, b.name)),
    exposes: exposedOutputs(tool, resources),
    withholds: "unknown",
  };
  const shape = tool.contract?.shape;
  if (shape && tool.contract) {
    exposure.withholds = classify(shape, mappingTargets(tool, resources));
    exposure.observation = { fixture: tool.contract.probeFixture, fingerprint: tool.contract.fingerprint };
  }
  if (tool.connector && !tool.response && !tool.extract) exposure.passthrough = true;
  return exposure;
}

/** `exposureOf` for every capability in an IR, sorted by capability id (D-9). */
export function exposureOfIR(ir: IR): ToolExposure[] {
  return [...ir.tools].sort((a, b) => byString(a.id, b.id)).map((t) => exposureOf(t, ir.resources));
}
