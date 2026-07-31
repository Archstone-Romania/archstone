// @archstone/init — the diff harness (ADD-37 §6 step 4).
//
// BUILT BEFORE THE GENERATOR IS GOOD, on purpose: it is the thing that converts this increment
// from an impression into a measurement, so that every day of work has a number attached.
//
// Two decisions carry the whole design:
//
//   1. **Compare compiled IRs, not YAML.** Two manifests can differ in every byte and compile
//      to the same tools; two manifests can look almost identical and compile to different
//      required sets. YAML equality measures typing style. IR equality measures what an agent
//      actually receives.
//
//   2. **Join tools by connector (`method` + `path`), never by id.** The id is the axis the
//      pass criterion explicitly EXCLUDES (naming and descriptions are not part of the
//      measure), so it cannot also be the join key — a generated `framing.list-frames` versus a
//      hand-written `framing.list-frame-profiles` would otherwise show up as two extras and one
//      miss, which measures nothing except that a human named it better.
//
// The four measured items (DoD-3):
//   (a) tool-set difference, with extras itemized;
//   (b) `effect` per matched tool;
//   (c) `response.fields` as an ORDER-INSENSITIVE `{name, path}` set;
//   (d) `resources[name]` required flags.
// Everything else — ids, descriptions, and the `ref:` → `identifier` degradation (R-4) — is
// RECORDED VERBATIM and EXCLUDED from the pass criterion. A known miss must not be able to
// hide inside a generic failure, and a generic failure must not be able to hide inside a known
// miss.

import type { IR, IRField, IRTool } from "@archstone/compiler";

/** Which side a finding is about. `expected` is the oracle (the hand-written manifest);
 *  `actual` is the manifest under measurement. */
export interface ToolRef {
  id: string;
  connector: string;
}

export interface ToolMatch {
  connector: string;
  expected: string;
  actual: string;
  /** True when the two were joined on a normalized path (placeholder names differ). */
  viaNormalizedPath?: boolean;
}

export interface EffectDivergence {
  connector: string;
  expected: string;
  actual: string;
}

export interface FieldSetDivergence {
  connector: string;
  /** `{name, path}` pairs the oracle has and the actual manifest does not. */
  missing: string[];
  /** `{name, path}` pairs the actual manifest has and the oracle does not. */
  extra: string[];
}

export interface RequiredDivergence {
  resource: string;
  field: string;
  expected: boolean;
  actual: boolean;
}

/** A divergence the pass criterion deliberately ignores, recorded so it stays visible. */
export interface KnownMiss {
  code: "identity-ref-not-inferred";
  connector: string;
  field: string;
  detail: string;
}

export interface NamingDelta {
  connector: string;
  expectedId: string;
  actualId: string;
  expectedDescription: string;
  actualDescription: string;
}

export interface IRDiff {
  /** (a) */
  matched: ToolMatch[];
  missingTools: ToolRef[];
  extraTools: ToolRef[];
  /** (b) */
  effectDivergences: EffectDivergence[];
  /** (c) */
  responseFieldDivergences: FieldSetDivergence[];
  /** (d) */
  requiredDivergences: RequiredDivergence[];
  /** The request `invokeRest` would build, compared for equivalent business intent. */
  requestDivergences: FieldSetDivergence[];
  /** Excluded from `clean`. */
  knownMisses: KnownMiss[];
  namingDeltas: NamingDelta[];
  /** True iff every measured item is zero. Known misses and naming deltas never affect it. */
  clean: boolean;
}

/** `GET /api/v1/catalog/frames/{frameProfileId}/price` — the join key. */
function connectorKey(tool: IRTool): string | undefined {
  const rest = tool.connector?.rest;
  if (!rest) return undefined;
  return `${rest.method.toUpperCase()} ${rest.path}`;
}

/**
 * The same key with every `{placeholder}` collapsed to `{}`.
 *
 * A second, weaker join pass: `GET /frames/{frameProfileId}` and `GET /frames/{frame_profile_id}`
 * address the identical endpoint and differ only in what the CDL calls the parameter — which is
 * a naming difference, the axis this measure excludes. Reporting them as one missing and one
 * extra tool would fail the whole comparison for a reason the criterion says not to count.
 * Matches found this way are flagged (`viaNormalizedPath`), never hidden.
 */
function normalizedConnectorKey(key: string): string {
  return key.replace(/\{[^}]*\}/g, "{}");
}

/** A tool's response mapping as an order-insensitive set of `field←path` strings. */
function responseFieldSet(tool: IRTool): Set<string> {
  const set = new Set<string>();
  for (const f of tool.response?.fields ?? []) set.add(`${f.name}←${f.path}`);
  if (tool.response?.collection !== undefined) set.add(`(collection)←${tool.response.collection}`);
  return set;
}

/**
 * The request `invokeRest` would build for equivalent business intent — NOT the CDL field
 * names.
 *
 * This is the distinction ADD-37 asks for explicitly, and it earns its keep on a real case:
 * ArtVinci's hand-written `widthCm` + `rest.query: {widthCm: width_cm}` and a spec-derived
 * `width_cm` with no remap produce the SAME wire request, and comparing CDL names would call
 * that a divergence. A wrong path or a parameter that moved between the URL and the query
 * string still fails, which is the part that matters.
 */
function requestShape(tool: IRTool): Set<string> {
  const rest = tool.connector?.rest;
  const shape = new Set<string>();
  if (!rest) return shape;
  const method = rest.method.toUpperCase();
  const pathParams = new Set([...rest.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!));
  // The provider consumes path placeholders positionally, so their WIRE identity is the path
  // segment they fill, not their name — normalize the path itself and record the position.
  shape.add(`path:${normalizedConnectorKey(`${method} ${rest.path}`)}`);
  for (const field of tool.input) {
    if (pathParams.has(field.name)) continue;
    const wire = rest.query?.[field.name] ?? field.name;
    // GET/HEAD send the remainder as a query string; everything else sends it as a JSON body,
    // where `rest.query` does not apply (`buildQuery` is only reached when there is no body).
    shape.add(method === "GET" || method === "HEAD" ? `query:${wire}` : `body:${field.name}`);
  }
  return shape;
}

function setDiff(expected: Set<string>, actual: Set<string>): { missing: string[]; extra: string[] } {
  const missing = [...expected].filter((v) => !actual.has(v)).sort();
  const extra = [...actual].filter((v) => !expected.has(v)).sort();
  return { missing, extra };
}

/**
 * The `{placeholder}` names in a tool's connector path, IN ORDER.
 *
 * The join key for inputs, and for the same reason the tool join uses the connector: a path
 * parameter's identity on the wire is the SEGMENT IT FILLS, not what the CDL calls it. The
 * oracle's `frameProfileId` and a spec-derived `id` are the same parameter of the same
 * endpoint.
 */
function pathPlaceholders(tool: IRTool): string[] {
  const path = tool.connector?.rest?.path ?? "";
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/**
 * Pair up two tools' inputs WITHOUT using the CDL field name as the join key.
 *
 * The file's own header says the id is the axis the pass criterion excludes and therefore
 * cannot also be the join key. That argument applies one level down and was not applied
 * there: known misses joined `act.input` by `field.name`, so on a real oracle
 * (`frameProfileId` vs `id`) the counterpart was never found, `continue` fired, and the
 * `ref:` → `identifier` degradation — R-4, the increment's HEADLINE known miss, likelihood
 * "H (certain)" — reported as zero. A known miss that cannot appear is worse than one that
 * appears too often: DoD-3(a) promises it "appears as a named known miss", and it did not.
 *
 * Path parameters pair BY POSITION; everything else falls back to the name, which is correct
 * for query/body fields because `requestShape` already establishes that those keep their wire
 * identity.
 */
function pairInputs(expected: IRTool, actual: IRTool): Map<string, IRField> {
  const pairs = new Map<string, IRField>();
  const actualByName = new Map(actual.input.map((f) => [f.name, f]));
  const expectedPath = pathPlaceholders(expected);
  const actualPath = pathPlaceholders(actual);

  for (const field of expected.input) {
    const position = expectedPath.indexOf(field.name);
    if (position !== -1) {
      const counterpartName = actualPath[position];
      const counterpart = counterpartName === undefined ? undefined : actualByName.get(counterpartName);
      if (counterpart) pairs.set(field.name, counterpart);
      continue;
    }
    const byName = actualByName.get(field.name);
    if (byName) pairs.set(field.name, byName);
  }
  return pairs;
}

/** The resource each tool's response maps onto, if any. */
function mappedResource(tool: IRTool): string | undefined {
  return tool.response?.resource;
}

function requiredByField(fields: IRField[] | undefined): Map<string, boolean> {
  return new Map((fields ?? []).map((f) => [f.name, f.required]));
}

/**
 * Compare two compiled IRs.
 *
 * @param expected the oracle — a hand-written, in-production manifest.
 * @param actual   the manifest under measurement.
 */
export function diffIR(expected: IR, actual: IR): IRDiff {
  const expectedByKey = new Map<string, IRTool>();
  const actualByKey = new Map<string, IRTool>();
  for (const t of expected.tools) {
    const key = connectorKey(t);
    if (key !== undefined) expectedByKey.set(key, t);
  }
  for (const t of actual.tools) {
    const key = connectorKey(t);
    if (key !== undefined) actualByKey.set(key, t);
  }

  const matched: ToolMatch[] = [];
  const pairs: Array<{ key: string; expected: IRTool; actual: IRTool }> = [];
  const unmatchedExpected = new Map(expectedByKey);
  const unmatchedActual = new Map(actualByKey);

  // Pass 1 — exact connector.
  for (const [key, exp] of expectedByKey) {
    const act = actualByKey.get(key);
    if (!act) continue;
    matched.push({ connector: key, expected: exp.id, actual: act.id });
    pairs.push({ key, expected: exp, actual: act });
    unmatchedExpected.delete(key);
    unmatchedActual.delete(key);
  }

  // Pass 2 — same endpoint, differently-named path parameters (see `normalizedConnectorKey`).
  const normalizedActual = new Map<string, [string, IRTool]>();
  for (const [key, act] of unmatchedActual) {
    const norm = normalizedConnectorKey(key);
    if (!normalizedActual.has(norm)) normalizedActual.set(norm, [key, act]);
  }
  for (const [key, exp] of [...unmatchedExpected]) {
    const hit = normalizedActual.get(normalizedConnectorKey(key));
    if (!hit) continue;
    const [actualKey, act] = hit;
    matched.push({ connector: key, expected: exp.id, actual: act.id, viaNormalizedPath: true });
    pairs.push({ key, expected: exp, actual: act });
    unmatchedExpected.delete(key);
    unmatchedActual.delete(actualKey);
    normalizedActual.delete(normalizedConnectorKey(key));
  }

  const effectDivergences: EffectDivergence[] = [];
  const responseFieldDivergences: FieldSetDivergence[] = [];
  const requiredDivergences: RequiredDivergence[] = [];
  const requestDivergences: FieldSetDivergence[] = [];
  const knownMisses: KnownMiss[] = [];
  const namingDeltas: NamingDelta[] = [];

  for (const { key, expected: exp, actual: act } of pairs) {
    // (b) effect
    if (exp.effect !== act.effect) {
      effectDivergences.push({ connector: key, expected: exp.effect, actual: act.effect });
    }

    // (c) response.fields, order-insensitive
    const fieldDiff = setDiff(responseFieldSet(exp), responseFieldSet(act));
    if (fieldDiff.missing.length > 0 || fieldDiff.extra.length > 0) {
      responseFieldDivergences.push({ connector: key, ...fieldDiff });
    }

    // (d) required flags of the mapped resource
    const expResource = mappedResource(exp);
    const actResource = mappedResource(act);
    if (expResource !== undefined && actResource !== undefined) {
      const expRequired = requiredByField(expected.resources[expResource]);
      const actRequired = requiredByField(actual.resources[actResource]);
      for (const [field, req] of expRequired) {
        const other = actRequired.get(field);
        // A field the actual manifest does not map at all is item (c)'s finding, not (d)'s —
        // reporting it twice would double-count one divergence.
        if (other !== undefined && other !== req) {
          requiredDivergences.push({ resource: expResource, field, expected: req, actual: other });
        }
      }
    }

    // The request as the provider would build it.
    const requestDiff = setDiff(requestShape(exp), requestShape(act));
    if (requestDiff.missing.length > 0 || requestDiff.extra.length > 0) {
      requestDivergences.push({ connector: key, ...requestDiff });
    }

    // R-4, recorded as a NAMED known miss rather than as a generic failure: an input the oracle
    // expresses as `ref: <Resource>` (an identity link an agent can follow back to the
    // capability that produced it) against a scalar `identifier`. No source construct implies
    // the link, so no adapter can infer it — but it must never disappear from the report.
    const pairedInputs = pairInputs(exp, act);
    for (const field of exp.input) {
      const counterpart = pairedInputs.get(field.name);
      if (!counterpart) continue;
      if (field.type.kind === "resource" && field.type.identity && counterpart.type.kind === "scalar" && counterpart.type.semantic === "identifier") {
        knownMisses.push({
          code: "identity-ref-not-inferred",
          connector: key,
          field: field.name,
          detail: `oracle declares \`ref: ${field.type.name}\`; generated declares \`type: identifier\``,
        });
      }
    }

    if (exp.id !== act.id || exp.description !== act.description) {
      namingDeltas.push({
        connector: key,
        expectedId: exp.id,
        actualId: act.id,
        expectedDescription: exp.description,
        actualDescription: act.description,
      });
    }
  }

  const missingTools: ToolRef[] = [...unmatchedExpected].map(([connector, t]) => ({ id: t.id, connector }));
  const extraTools: ToolRef[] = [...unmatchedActual].map(([connector, t]) => ({ id: t.id, connector }));

  const clean =
    missingTools.length === 0 &&
    extraTools.length === 0 &&
    effectDivergences.length === 0 &&
    responseFieldDivergences.length === 0 &&
    requiredDivergences.length === 0 &&
    requestDivergences.length === 0;

  return {
    matched,
    missingTools,
    extraTools,
    effectDivergences,
    responseFieldDivergences,
    requiredDivergences,
    requestDivergences,
    knownMisses,
    namingDeltas,
    clean,
  };
}

/** A human-readable rendering of a diff — the committable report artifact (product §11.2). */
export function formatDiff(diff: IRDiff): string {
  const lines: string[] = [];
  lines.push(`tools matched: ${diff.matched.length}, missing: ${diff.missingTools.length}, extra: ${diff.extraTools.length}`);
  for (const m of diff.matched) {
    lines.push(`  = ${m.connector}${m.viaNormalizedPath ? "  (matched on a normalized path — placeholder names differ)" : ""}`);
  }
  for (const t of diff.missingTools) lines.push(`  - missing: ${t.connector} (oracle: ${t.id})`);
  for (const t of diff.extraTools) lines.push(`  + extra:   ${t.connector} (${t.id})`);
  for (const d of diff.effectDivergences) lines.push(`  ! effect ${d.connector}: expected ${d.expected}, got ${d.actual}`);
  for (const d of diff.responseFieldDivergences) {
    lines.push(`  ! response.map ${d.connector}: missing [${d.missing.join(", ")}] extra [${d.extra.join(", ")}]`);
  }
  for (const d of diff.requiredDivergences) {
    lines.push(`  ! required ${d.resource}.${d.field}: expected ${d.expected}, got ${d.actual}`);
  }
  for (const d of diff.requestDivergences) {
    lines.push(`  ! request ${d.connector}: missing [${d.missing.join(", ")}] extra [${d.extra.join(", ")}]`);
  }
  for (const k of diff.knownMisses) lines.push(`  ~ known miss (${k.code}) ${k.connector}.${k.field}: ${k.detail}`);
  for (const n of diff.namingDeltas) lines.push(`  ~ naming (excluded) ${n.connector}: '${n.expectedId}' vs '${n.actualId}'`);
  lines.push(diff.clean ? "RESULT: clean — zero on all four measured items." : "RESULT: divergent.");
  return lines.join("\n");
}
