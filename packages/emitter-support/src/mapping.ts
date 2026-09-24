// @archstone/emitter-support — Response mapper (ADD-12 / RFC-0006).
//
// Applies a tool's IRResponseMapping to a live provider body: locate the item list,
// map each item's resource fields, and validate required fields. Pure (no MCP, no HTTP,
// no I/O) so the contract probe (#18) replays the exact same code path — one
// behaviour, tested once. Required-ness is read from the resource registry (not the
// mapping), so this can never disagree with the emitted outputSchema (ADD-11).
//
// Moved out of @archstone/runtime's mapping.ts (ADD-0008 #27), unchanged logic.
//
// Extended (per the accepted architecture decision extending ADD-12) to also evaluate
// `tool.extract`: additional SCALAR output fields read straight off the raw body ROOT — never
// `mapping.collection`-scoped items — with required-ness sourced from `tool.output` directly
// (there is no resource registry entry for a scalar field). Both mechanisms write into the SAME
// `data`/`missing`/`degraded` accumulators below: one `MappingResult`, one merged violation
// message when either side is missing a required field, never two separate error paths.
//
// #82 (ADD-12 §8.2): `extract:` also admits an array of one semantic scalar type — the loop
// below switches from `firstMatch` to "all matches" when the declared output field's IRType is
// `list` (issue #63's kind), and an empty match set is OK (mirrors `collection`'s existing
// empty-is-OK rule below), never DEGRADED.
//
// #81 (ADD-12 §8.1): a `response:` mapping may declare `onError` — a row-level discriminator
// that classifies each collection item BEFORE the success mapping runs. A row matching `when`
// is mapped against `onError.errorResource` (fields read by same-named key on the item — the
// error resource has no separate `map:`, it IS the row, per its own field declarations) and
// tagged `$row: "error"`; every other row is mapped against `resource` exactly as without this
// block and tagged `$row: "ok"`, required fields enforced in full. A non-error row missing one
// of those required fields is a PER-ROW violation, named but never silently dropped and never
// loosening any other row's required-ness. The whole-response VIOLATION fires only when the
// collection is non-empty and zero rows end up usable (mapped, whether `ok` or `error`).

import { evalPath, type IRField, type IRResourceRegistry, type IRTool, type IRDiscriminator } from "@archstone/compiler";

export type MappingStatus = "ok" | "degraded" | "violation";

/** One collection row that matched neither the success shape (fully) nor the declared error
 *  shape — #81's "row missing a required field, and not declared as a row-level error, still
 *  violates" scenario. Named so a caller can tell it apart from a declared error row (which
 *  lands in `data`, tagged `$row: "error"`) and from the whole-response VIOLATION (which this
 *  is deliberately NOT, as long as some other row is usable). */
export interface RowViolation {
  index: number; // position in the collection (0-based)
  missing: string[]; // the resource's required field(s) this row did not carry
}

export interface MappingResult {
  status: MappingStatus;
  data?: Record<string, unknown>; // { [outputField]: mappedArray | mappedObject } — matches outputSchema
  missing?: string[]; // required fields absent → VIOLATION (fail-closed, no raw fallback)
  degraded?: string[]; // optional fields absent → DEGRADED (returned, field omitted)
  /** #81: present iff `response.onError` is declared AND at least one row failed to match
   *  either the success or the declared error shape. Never present without `onError` — without
   *  it, a row missing a required field is exactly the whole-response VIOLATION it always was. */
  rowViolations?: RowViolation[];
}

/** First JSONPath match, or undefined when the path resolves to nothing. */
function firstMatch(json: unknown, path: string): unknown {
  const matches = evalPath(json, path);
  return matches.length > 0 ? matches[0] : undefined;
}

/** #81 — does one collection item match a row-error discriminator? `exists` checks presence at
 *  `path`; `equals` checks JSON equality against the first match; declaring neither (shape-valid
 *  but pointless) matches on plain presence, the same floor `exists` alone would give. */
function matchesDiscriminator(item: unknown, when: IRDiscriminator): boolean {
  const matches = evalPath(item, when.path);
  const present = matches.length > 0 && matches[0] !== undefined && matches[0] !== null;
  if (when.exists !== undefined) return present === when.exists;
  if ("equals" in when) return present && JSON.stringify(matches[0]) === JSON.stringify(when.equals);
  return present;
}

/** Map one declared row (success or #81 error) shape against an item, by field name → path
 *  (success) or field name → same-named key on the item (error — no separate `map:`, see file
 *  header). Returns the mapped object plus which required fields were absent. */
function mapRow(
  item: unknown,
  fields: IRField[],
  byPath: Map<string, string> | undefined, // fieldName -> path, for the success shape only
  tag: "ok" | "error" | undefined,
): { obj: Record<string, unknown>; missing: string[]; degraded: string[] } {
  const obj: Record<string, unknown> = {};
  if (tag) obj.$row = tag;
  const missing: string[] = [];
  const degraded: string[] = [];
  for (const f of fields) {
    const path = byPath?.get(f.name) ?? `$.${f.name}`;
    const value = firstMatch(item, path);
    if (value === undefined || value === null) {
      if (f.required) missing.push(f.name);
      else degraded.push(f.name);
      continue;
    }
    obj[f.name] = value;
  }
  return { obj, missing, degraded };
}

/**
 * Map + validate a provider body against the tool's response mapping and/or `extract:` block. A
 * required field — per the resource registry for `response:`, or per `tool.output` directly for
 * `extract:` (there is no resource here), unless loosened by `requiredOverride` — that resolves
 * to nothing (on any item, for `response:`; at the body root, for `extract:`) is a VIOLATION; an
 * absent optional field DEGRADES. An empty collection is OK (emptiness is not drift). Both
 * mechanisms write into the SAME accumulators, so a caller sees one merged result no matter which
 * one (or both) a tool declares.
 */
export function applyResponseMapping(tool: IRTool, body: unknown, resources: IRResourceRegistry): MappingResult {
  const mapping = tool.response;
  const extract = tool.extract;
  if (!mapping && !extract) return { status: "ok", data: {} }; // caller guards on tool.response || tool.extract; defensive

  const missing = new Set<string>();
  const degraded = new Set<string>();
  const rowViolations: RowViolation[] = [];
  const data: Record<string, unknown> = {};
  let wholeResponseViolation = false;

  if (mapping) {
    const resourceFields = resources[mapping.resource] ?? [];
    const requiredByName = new Map(resourceFields.map((f) => [f.name, f.required]));
    const pathByName = new Map(mapping.fields.map((fm) => [fm.name, fm.path]));
    // The success shape's field list is `mapping.fields` (only the fields THIS binding
    // declares a path for — a resource field with no `map:` entry is simply never populated,
    // exactly as before #81), with required-ness read from the resource registry and
    // `requiredOverride` folded in so `mapRow`'s generic required check applies uniformly.
    const successFields: IRField[] = mapping.fields.map((fm) => ({
      name: fm.name,
      required: (requiredByName.get(fm.name) ?? true) && fm.requiredOverride !== false,
      type: { kind: "scalar", semantic: "text" }, // unused by mapRow below; required-ness is all that matters here
    }));
    const items: unknown[] = mapping.collection ? evalPath(body, mapping.collection) : [body];
    const onError = mapping.onError;
    const errorFields = onError ? resources[onError.errorResource] ?? [] : [];

    if (!onError) {
      // Unchanged pre-#81 behaviour: every row mapped against `resource`, any missing required
      // field anywhere is a whole-response VIOLATION (no per-row distinction to make).
      const mapped: Record<string, unknown>[] = [];
      for (const item of items) {
        const { obj, missing: rowMissing, degraded: rowDegraded } = mapRow(item, successFields, pathByName, undefined);
        rowMissing.forEach((m) => missing.add(m));
        rowDegraded.forEach((d) => degraded.add(d));
        mapped.push(obj);
      }
      data[mapping.field] = mapping.collection ? mapped : mapped[0];
    } else {
      // #81: classify each row first. A declared error row is mapped against `errorResource`
      // and tagged; everything else is mapped against `resource`, tagged, and a row that fails
      // required-ness there is a PER-ROW violation — named, dropped from `data`, never folded
      // into the shared `missing` set (which would wrongly fail every OTHER row too).
      const mapped: Record<string, unknown>[] = [];
      let usable = 0;
      items.forEach((item, index) => {
        if (matchesDiscriminator(item, onError.when)) {
          const { obj, missing: rowMissing } = mapRow(item, errorFields, undefined, "error");
          if (rowMissing.length > 0) {
            rowViolations.push({ index, missing: rowMissing });
          } else {
            mapped.push(obj);
            usable++;
          }
          return;
        }
        const { obj, missing: rowMissing, degraded: rowDegraded } = mapRow(item, successFields, pathByName, "ok");
        if (rowMissing.length > 0) {
          rowViolations.push({ index, missing: rowMissing });
        } else {
          rowDegraded.forEach((d) => degraded.add(d));
          mapped.push(obj);
          usable++;
        }
      });
      data[mapping.field] = mapped;
      if (items.length > 0 && usable === 0) wholeResponseViolation = true;
    }
  }

  if (extract) {
    // Body-root only, deliberately: `extract:` never scopes into `mapping.collection`'s items —
    // it reaches capability-level scalars, not per-item fields (that stays `response.map`'s job).
    const outputByName = new Map(tool.output.map((f) => [f.name, f]));
    for (const fm of extract) {
      const field = outputByName.get(fm.name);
      const required = (field?.required ?? true) && fm.requiredOverride !== false;

      if (field?.type.kind === "list") {
        // #82: an array output field — ALL matches, not just the first. An empty match set is
        // OK (mirrors `collection`'s existing empty-is-OK rule above), never DEGRADED.
        data[fm.name] = evalPath(body, fm.path);
        continue;
      }

      const value = firstMatch(body, fm.path);
      if (value === undefined || value === null) {
        if (required) missing.add(fm.name);
        else degraded.add(fm.name);
        continue;
      }
      data[fm.name] = value;
    }
  }

  if (missing.size > 0 || wholeResponseViolation) {
    // Every row failed (#81's "every row fails" scenario): `missing` never accumulated
    // per-row failures (that would wrongly implicate every OTHER row), so when it is what
    // makes this a whole-response VIOLATION, name the union of what each failing row lacked —
    // `contractViolationMessage` still has something to say.
    if (missing.size === 0) for (const rv of rowViolations) rv.missing.forEach((m) => missing.add(m));
    const result: MappingResult = { status: "violation", missing: [...missing] };
    if (rowViolations.length > 0) result.rowViolations = rowViolations;
    return result;
  }
  const status: MappingStatus = degraded.size > 0 ? "degraded" : "ok";
  const result: MappingResult = { status, data };
  if (degraded.size > 0) result.degraded = [...degraded];
  if (rowViolations.length > 0) result.rowViolations = rowViolations;
  return result;
}

/**
 * The human text a contract VIOLATION is reported with — one spelling, shared by both
 * invocation consumers (#44).
 *
 * Extracted rather than duplicated because the audit record must carry, verbatim, the message
 * the consumer already surfaces, and the two consumers surface a violation differently: the MCP
 * path returns this exact sentence as tool content (five shipped assertions pin it byte-for-
 * byte), while the embedded path returns `{status:"violation", missing}` with no text at all.
 * Without one shared spelling, an `mcp` record and a `function-calling` record for the identical
 * failure would read differently — precisely the drift a single record builder exists to
 * prevent, and invisible until an auditor compares the two.
 */
export function contractViolationMessage(capabilityId: string, missing: readonly string[]): string {
  return `contract violation: capability '${capabilityId}' — provider response is missing required field(s): ${missing.join(", ")}. Declared output shape not met; raw body withheld.`;
}
