// The OpenAPI adapter — schema → Draft node (ADD-37 Amendment 1 D-10, D-12's adapter half).
//
// THE ONE RULE THAT DECIDES WHAT IS IN HERE AND WHAT IS NOT: a construct is handled iff
// reducing it requires NO CHOICE. `allOf` qualifies — the merged shape is a total,
// order-independent function of its members — and that is why it moved in, not because the
// only oracle happened to need it. `oneOf` with two real members does not qualify: which
// shape is it? Nobody but a human can say, so it is refused. `discriminator` marks
// polymorphism explicitly, so where it appears the merged shape is stated not to be the whole
// story, and it is refused too.
//
// If the next argument for letting a construct in is "the oracle needs it", that is the wrong
// argument and should be refused on sight.

import { absent, declared, type DraftNode, type DraftObjectNode, type DraftProperty, type Fact } from "../../model";
import { note, type Note, type ReasonCode } from "../../reasons";
import { DocumentSet, isObject, resolveRef, type JsonObject, type JsonValue } from "./document";
import type { SemanticType } from "@archstone/compiler";

/** Where a lowering is happening, for notes and for `Fact.source`. */
export interface LowerContext {
  docs: DocumentSet;
  /** Operation key or `#/components/schemas/X` — whatever a human would search for. */
  target: string;
  notes: Note[];
  /** Set when a construct forces the whole operation to be skipped. First one wins. */
  fatal?: { code: ReasonCode; detail: string };
}

/** Raise an operation-scope refusal. Idempotent: the first cause is the honest one. */
function fatal(ctx: LowerContext, code: ReasonCode, detail: string): void {
  if (!ctx.fatal) ctx.fatal = { code, detail };
}

/** A schema plus the document it lives in — a `$ref` inside it resolves against THAT document,
 *  not against whichever one pointed here. Getting this wrong is how a multi-file spec
 *  silently resolves the wrong component. */
interface Located {
  schema: JsonObject;
  docKey: string;
  /** `#/components/schemas/FrameProfile` → `FrameProfile`, when the schema arrived by `$ref`. */
  componentName?: string;
  /** Source locator for the report and for `Fact.source`. */
  source: string;
}

const MAX_REF_DEPTH = 64;

/**
 * Follow `$ref` chains until a concrete schema (or a failure).
 *
 * `seen` carries the `<doc>#<pointer>` identities already visited on THIS path, so a cycle is
 * a named refusal (`unsupported-ref`) rather than a stack overflow — D-10.2's cycle check,
 * which matters the moment a schema is recursive, and recursive schemas are ordinary.
 */
function follow(located: Located, ctx: LowerContext, seen: ReadonlySet<string>): Located | undefined {
  let current = located;
  const visited = new Set(seen);
  for (let depth = 0; depth < MAX_REF_DEPTH; depth += 1) {
    const ref = current.schema["$ref"];
    if (typeof ref !== "string") return current;

    const resolved = resolveRef(ctx.docs, current.docKey, ref);
    if (typeof resolved === "string") {
      ctx.notes.push(note("unsupported-ref", "field", ctx.target, `${ref} (${resolved})`));
      return undefined;
    }
    if (visited.has(resolved.id)) {
      ctx.notes.push(note("unsupported-ref", "field", ctx.target, `circular $ref at ${resolved.id}`));
      return undefined;
    }
    visited.add(resolved.id);
    if (!isObject(resolved.node)) {
      ctx.notes.push(note("unsupported-ref", "field", ctx.target, `${ref} does not point at a schema object`));
      return undefined;
    }
    current = {
      schema: resolved.node,
      docKey: resolved.docKey,
      componentName: componentNameOf(ref) ?? current.componentName,
      source: ref,
    };
  }
  ctx.notes.push(note("unsupported-ref", "field", ctx.target, `$ref chain deeper than ${MAX_REF_DEPTH}`));
  return undefined;
}

/** `_shared.yaml#/components/schemas/Pagination` → `Pagination`. */
function componentNameOf(ref: string): string | undefined {
  const match = /#\/components\/schemas\/([^/]+)$/.exec(ref);
  return match ? match[1] : undefined;
}

/** The `type` keyword as a set, covering 3.1's union form (`type: [string, 'null']`). */
function typeSet(schema: JsonObject): Set<string> {
  const raw = schema["type"];
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw)) return new Set(raw.filter((t): t is string => typeof t === "string"));
  return new Set();
}

/** Is this schema's ONLY assertion that the value is null? D-10.6's discard test. */
function isNullOnly(schema: JsonObject): boolean {
  const types = typeSet(schema);
  return types.size === 1 && types.has("null");
}

/**
 * D-10.6 — reduce a `oneOf`/`anyOf` iff, after discarding members whose only assertion is
 * `type: 'null'`, exactly ONE member remains. The result is that member, marked nullable.
 *
 * This is the nullability idiom and nothing else. `FramePriceResponse.geometry: oneOf:
 * [FrameGeometry, {type: 'null'}]` reduces (and is what keeps that whole capability alive);
 * `Forbidden: oneOf: [Error, CodedError]` is genuine polymorphism and refuses — harmlessly,
 * since it is an error response and error responses are never mapped.
 */
function reduceUnion(schema: JsonObject, key: "oneOf" | "anyOf"): { member: JsonValue; nullable: true } | "absent" | "irreducible" {
  const raw = schema[key];
  if (!Array.isArray(raw)) return "absent";
  const members = raw.filter((m) => !(isObject(m) && isNullOnly(m)));
  const droppedANull = members.length !== raw.length;
  if (members.length === 1 && droppedANull) return { member: members[0]!, nullable: true };
  return "irreducible";
}

/**
 * The MERGED shape of one schema: its own keywords composed with every `allOf` member's,
 * recursively, depth-unbounded, cycle-checked (D-10.1–.3).
 *
 * D-10.1 is the one that is easy to get wrong and expensive when you do: `allOf` merges with
 * the schema's OWN `properties`/`required`/`type`, per JSON Schema 2020-12. `FrameProfileList`
 * is `{type: object, required: [...], properties: {items}, allOf: [Pagination]}`, and an
 * implementation that reads `allOf` as "the schema IS its members" loses `items` — and with it
 * the entire list capability.
 */
interface Merged {
  types: Set<string>;
  properties: Map<string, Located[]>;
  required: Set<string>;
  description?: string;
  componentName?: string;
  enumValues?: JsonValue[];
  constValue?: JsonValue;
  format?: string;
  example?: JsonValue;
  items?: Located;
  /** Set by a reduced `oneOf`/`anyOf`, or by 3.0's `nullable: true`, or by a `type` union. */
  nullableByUnion: boolean;
  /** True when SOME construct on this schema left its nullability undeterminable. */
  nullabilityUnknown: boolean;
}

function emptyMerged(): Merged {
  return { types: new Set(), properties: new Map(), required: new Set(), nullableByUnion: false, nullabilityUnknown: false };
}

function mergeInto(target: Merged, located: Located, ctx: LowerContext, seen: ReadonlySet<string>, depth: number): void {
  if (depth > MAX_REF_DEPTH) {
    fatal(ctx, "unsupported-composition", "allOf nesting deeper than the resolver's cap");
    return;
  }
  const followed = follow(located, ctx, seen);
  if (!followed) {
    // An unresolvable member could contribute anything, including an array-of-objects
    // property that changes the D-9 step-1 census. Fail closed at operation scope.
    fatal(ctx, "unsupported-ref", `a composed member of ${ctx.target} could not be resolved`);
    return;
  }
  const schema = followed.schema;
  const nextSeen = new Set(seen);
  if (followed.componentName) nextSeen.add(`${followed.docKey}#/components/schemas/${followed.componentName}`);

  // D-10.5 — `discriminator` marks polymorphism; where it appears, the merged shape is
  // explicitly not the whole story. Refuse, never merge.
  if (schema["discriminator"] !== undefined) {
    fatal(ctx, "unsupported-composition", "a `discriminator` marks polymorphism the merged shape cannot represent");
    return;
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const reduced = reduceUnion(schema, key);
    if (reduced === "absent") continue;
    if (reduced === "irreducible") {
      fatal(ctx, "unsupported-composition", `\`${key}\` with more than one non-null member`);
      return;
    }
    target.nullableByUnion = true;
    if (isObject(reduced.member)) {
      mergeInto(target, { schema: reduced.member, docKey: followed.docKey, source: `${followed.source}/${key}` }, ctx, nextSeen, depth + 1);
      if (ctx.fatal) return;
    }
  }

  for (const t of typeSet(schema)) {
    if (t === "null") target.nullableByUnion = true;
    else target.types.add(t);
  }
  if (schema["nullable"] === true) target.nullableByUnion = true;

  if (typeof schema["description"] === "string" && target.description === undefined) target.description = schema["description"];
  if (followed.componentName !== undefined && target.componentName === undefined) target.componentName = followed.componentName;
  if (typeof schema["format"] === "string" && target.format === undefined) target.format = schema["format"];
  if (schema["example"] !== undefined && target.example === undefined) target.example = schema["example"];
  if (Array.isArray(schema["enum"]) && target.enumValues === undefined) target.enumValues = schema["enum"];
  if (schema["const"] !== undefined && target.constValue === undefined) target.constValue = schema["const"];

  const items = schema["items"];
  if (isObject(items) && target.items === undefined) {
    target.items = { schema: items, docKey: followed.docKey, source: `${followed.source}/items` };
  }

  const required = schema["required"];
  if (Array.isArray(required)) for (const r of required) if (typeof r === "string") target.required.add(r);

  const properties = schema["properties"];
  if (isObject(properties)) {
    for (const [name, value] of Object.entries(properties)) {
      if (!isObject(value)) continue;
      const bucket = target.properties.get(name) ?? [];
      bucket.push({ schema: value, docKey: followed.docKey, source: `${followed.source}/properties/${name}` });
      target.properties.set(name, bucket);
    }
  }

  // D-10.2 — recurse into `allOf`. AFTER the schema's own keywords, so that a merge is
  // order-independent in effect: every field below takes the first value it sees and the sets
  // are unions, so which member supplied a description is not load-bearing.
  //
  // D-10.3's easily-missed case: a member contributing ONLY a `description` is a no-op merge,
  // never an empty-object contradiction. `FrameProfileListItem.allOf[2]` is exactly that, and
  // an implementation that treats "an object schema with no properties" as a constraint
  // empties the shape.
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const member of allOf) {
      if (!isObject(member)) continue;
      mergeInto(target, { schema: member, docKey: followed.docKey, source: `${followed.source}/allOf` }, ctx, nextSeen, depth + 1);
      if (ctx.fatal) return;
    }
  }
}

/**
 * D-10.3's `type` clause, which the merge itself cannot enforce: members must AGREE on the
 * structural kind, or be silent about it.
 *
 * The merge unions `type` sets, which is right for `[string, 'null']` and wrong for a
 * contradiction: `allOf: [{type: array}, {type: object}]` would union to `{array, object}` and
 * then be resolved silently by whichever check runs first. Nothing satisfies both, so there is
 * no merged shape to speak of — and picking one is a guess, which is the single thing this
 * whole adapter is built not to do.
 *
 * Escalated for the same reason D-10.4's exception is: the structural kind is a direct input
 * to D-9 step 1's locus census. A quietly-chosen `array` would present itself as a collection
 * that the document never actually described.
 */
function assertConsistentKind(m: Merged, ctx: LowerContext): void {
  const structural = ["object", "array"].filter((k) => m.types.has(k));
  const scalarish = [...m.types].filter((k) => k !== "object" && k !== "array" && k !== "null");
  if (structural.length > 1 || (structural.length === 1 && scalarish.length > 0)) {
    fatal(ctx, "unsupported-composition", `composed schemas disagree about the structural kind: ${[...m.types].sort().join(" vs ")}`);
  }
}

function merge(located: Located, ctx: LowerContext, seen: ReadonlySet<string>): Merged {
  const merged = emptyMerged();
  mergeInto(merged, located, ctx, seen, 0);
  if (!ctx.fatal) assertConsistentKind(merged, ctx);
  return merged;
}

// ---------------------------------------------------------------------------------------
// Merged shape → Draft node
// ---------------------------------------------------------------------------------------

function isArrayShape(m: Merged): boolean {
  return m.types.has("array") || (m.types.size === 0 && m.items !== undefined);
}

function isObjectShape(m: Merged): boolean {
  return m.types.has("object") || (!isArrayShape(m) && m.properties.size > 0);
}

/**
 * Nullability, from all four sources A-3 names, expressed as POSITIVE evidence where the
 * document supplies it and as an honest `absent` where it does not (D-12's adapter obligation).
 *
 * An adapter that returned `absent` everywhere would make every field optional; one that
 * returned `declared(false)` everywhere would ship a manifest that VIOLATES on the first real
 * null. The line between them is exactly "did the document say something that settles it".
 */
function nullabilityOf(m: Merged): Fact<boolean> {
  if (m.nullableByUnion) return declared(true);
  if (Array.isArray(m.enumValues)) return declared(m.enumValues.includes(null));
  if (m.constValue !== undefined) return declared(m.constValue === null);
  // A stated `type` that does not include `null` is 3.1's positive statement of
  // non-nullability; in 3.0 the same schema without `nullable: true` says the same thing.
  if (m.types.size > 0) return declared(false);
  return absent<boolean>("the schema states no type, enum or const, so nothing settles nullability");
}

/** Enum values as CDL wants them: strings only, with `null` dropped (A-3 source 4). */
function enumStrings(values: JsonValue[]): { values: string[]; droppedNull: boolean; lossy: boolean } {
  const droppedNull = values.includes(null);
  const kept: string[] = [];
  let lossy = false;
  for (const v of values) {
    if (v === null) continue;
    if (typeof v === "string") kept.push(v);
    else lossy = true;
  }
  return { values: kept, droppedNull, lossy };
}

/**
 * The semantic type, and the CDL `values` set when there is one.
 *
 * `null` MUST be stripped from `values`: `cdl.schema.json` declares `values.items: {type:
 * string}` with `minItems: 1`, so a `null` in there makes the emitted file shape-invalid, the
 * loop's own compile check fails, D-7 refuses, and the whole run writes nothing — loud rather
 * than silent, but it costs the run for one enum (A-3).
 */
function semanticTypeOf(m: Merged, ctx: LowerContext, where: string): { type: Fact<SemanticType>; values?: string[] } {
  const source = where;

  if (Array.isArray(m.enumValues)) {
    const { values, lossy } = enumStrings(m.enumValues);
    if (lossy) ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: non-string enum member(s) dropped`));
    if (values.length > 0) return { type: declared<SemanticType>("enum", source), values };
    ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: enum has no string members`));
    return { type: declared<SemanticType>("string", source) };
  }

  // A-3: `const` with no `type` is unhandled by §1's type table, and without a rule the field
  // simply VANISHES from the map. A string const is faithfully a one-value enum (legal —
  // `minItems: 1`); anything else degrades rather than inventing a primitive.
  if (m.constValue !== undefined) {
    if (typeof m.constValue === "string") return { type: declared<SemanticType>("enum", source), values: [m.constValue] };
    ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: a non-string \`const\` has no CDL primitive`));
    return { type: declared<SemanticType>("string", source) };
  }

  if (m.types.has("string")) {
    if (m.format === "date") return { type: declared<SemanticType>("date", source) };
    if (m.format === "date-time") return { type: declared<SemanticType>("datetime", source) };
    // "else string/text" (product D-4). Reported per field, because this is precisely where a
    // human knows something the document does not: "this may be a `location`, a `money`, a
    // `party`; only you know."
    ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: a bare \`type: string\` implies no richer type`));
    return { type: declared<SemanticType>("string", source) };
  }
  if (m.types.has("number") || m.types.has("integer")) return { type: declared<SemanticType>("quantity", source) };
  if (m.types.has("boolean")) {
    // CDL HAS NO BOOLEAN SEMANTIC TYPE. Verified against `SEMANTIC_TYPES` in the compiler's
    // ir.ts, not assumed. Adding one is a Rule #10/#11 decision (a shipped primitive is
    // permanent) and is emphatically not this increment's to take, so a boolean degrades to
    // `string` and says so. Named in the report as a real gap, not absorbed here.
    ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: CDL has no boolean primitive — emitted as \`string\``));
    return { type: declared<SemanticType>("string", source) };
  }

  ctx.notes.push(note("semantic-type-degraded", "field", ctx.target, `${where}: the schema states no usable type`));
  return { type: absent<SemanticType>("no type keyword") };
}

/** Do two schemas reduce to the SAME Draft scalar? D-10.4's "not a conflict" test. */
function sameScalar(a: DraftNode, b: DraftNode): boolean {
  if (a.kind !== "scalar" || b.kind !== "scalar") return false;
  const typeEq =
    a.type.derivation === b.type.derivation && (a.type.derivation === "absent" || b.type.derivation === "absent" || a.type.value === b.type.value);
  const nullEq =
    a.nullable.derivation === b.nullable.derivation &&
    (a.nullable.derivation === "absent" || b.nullable.derivation === "absent" || a.nullable.value === b.nullable.value);
  const valuesEq = JSON.stringify(a.values ?? null) === JSON.stringify(b.values ?? null);
  return typeEq && nullEq && valuesEq;
}

function isArrayOfObjects(node: DraftNode): boolean {
  return node.kind === "array" && node.items.kind === "object";
}

/**
 * Lower one schema to a Draft node.
 *
 * The `allOf` merge completes BEFORE any of this runs (D-10.2), which is what lets D-9's
 * decision procedure — running later, in the pure emitter — see a single flat shape and never
 * know composition existed.
 */
export function lowerSchema(schema: JsonObject, docKey: string, source: string, ctx: LowerContext, seen: ReadonlySet<string> = new Set()): DraftNode {
  const m = merge({ schema, docKey, source }, ctx, seen);
  if (ctx.fatal) return { kind: "unknown" };

  const nextSeen = new Set(seen);
  if (m.componentName) nextSeen.add(`${docKey}#/components/schemas/${m.componentName}`);

  if (isArrayShape(m)) {
    if (!m.items) return { kind: "unknown" };
    const items = lowerSchema(m.items.schema, m.items.docKey, m.items.source, ctx, nextSeen);
    return { kind: "array", items };
  }

  if (isObjectShape(m)) {
    const properties: DraftProperty[] = [];
    for (const [name, candidates] of m.properties) {
      const lowered = candidates.map((c) => lowerSchema(c.schema, c.docKey, c.source, ctx, nextSeen));
      if (ctx.fatal) return { kind: "unknown" };
      const node = resolveCandidates(name, lowered, ctx);
      properties.push({
        name,
        // A `required[]` entry is a DECLARATION; its absence from `required[]` is equally a
        // declaration, in a document that has a `required[]` at all. Both are `declared`.
        declaredRequired: declared(m.required.has(name), `${source}/required`),
        node,
      });
    }
    const object: DraftObjectNode = {
      kind: "object",
      name: m.componentName === undefined ? absent<string>() : declared(m.componentName, source),
      description: m.description === undefined ? absent<string>() : declared(m.description, source),
      properties,
    };
    return object;
  }

  const { type, values } = semanticTypeOf(m, ctx, source);
  return {
    kind: "scalar",
    type,
    ...(values ? { values } : {}),
    nullable: nullabilityOf(m),
    description: m.description === undefined ? absent<string>() : declared(m.description, source),
    example: m.example === undefined ? absent<unknown>() : declared(m.example as unknown, source),
  };
}

/**
 * D-10.4 — two composed members supplying a schema for the SAME property key.
 *
 * Field-scoped by default: the merged property becomes `unknown` plus `composition-conflict`,
 * and it is simply not mapped. Escalating one bad property to an operation skip would re-open
 * the 100%-skip failure D-10 exists to close.
 *
 * THE ONE EXCEPTION, and it must stay exactly this narrow: if the members disagree about
 * whether the key is an ARRAY OF OBJECTS, the D-9 step-1 locus census is unsound. An `unknown`
 * node is invisible to `locateItemLocus`, so a genuinely ambiguous response would be rounded
 * down to "exactly one collection" — a guess wearing the costume of a refusal. That case
 * escalates.
 */
function resolveCandidates(name: string, lowered: DraftNode[], ctx: LowerContext): DraftNode {
  const first = lowered[0]!;
  if (lowered.length === 1) return first;

  const rest = lowered.slice(1);
  if (rest.every((n) => sameScalar(first, n))) return first;

  // Structurally identical candidates are common and harmless — the same `$ref` reached twice
  // through different members of a composition.
  if (rest.every((n) => JSON.stringify(n) === JSON.stringify(first))) return first;

  // THE ESCALATION, and the condition is "any candidate is an array of objects", NOT "the
  // candidates disagree about being one".
  //
  // The narrower form was a real hole. Two members can AGREE that a key is a list and still
  // disagree about the item — `results: array<Alpha>` versus `results: array<Beta>`. That fell
  // through to a field-scoped conflict, the property became `unknown`, and `locateItemLocus`
  // filters on `isArrayOfObjects`, which `unknown` fails. So the collection disappeared from
  // the D-9 step-1 census entirely, and an operation both sides of the merge agreed returns a
  // list degraded to connector-only with no output. Silent, and wrong in the direction that
  // produces a compiling manifest.
  //
  // The governing rule, stated so the next construct is judged by it rather than by this
  // example: escalate whenever a disagreement could change ANY INPUT to D-9 step 1. Step 1
  // reads exactly two things about a property — is it an array of objects, and is it a scalar
  // leaf. This covers the first. The second is already fail-SAFE rather than fail-open: a
  // scalar-versus-object conflict yields `unknown`, which costs the operation its `≥1 scalar
  // leaf` only when there is no other scalar, and then degrades it to `no-response-shape` —
  // an emitted connector with a report line, never an invented locus.
  if (lowered.some(isArrayOfObjects)) {
    fatal(
      ctx,
      "unsupported-composition",
      `composed schemas describe '${name}' as different item collections, which would make the item-locus census a guess`,
    );
    return { kind: "unknown" };
  }

  ctx.notes.push(note("composition-conflict", "field", `${ctx.target}#${name}`, `${lowered.length} composed members describe '${name}' differently`));
  return { kind: "unknown" };
}

/** Lower a schema that arrived by `$ref` or inline, for a response or a request body. */
export function lowerTopLevel(node: JsonValue, docKey: string, source: string, ctx: LowerContext): DraftNode {
  if (!isObject(node)) return { kind: "unknown" };
  return lowerSchema(node, docKey, source, ctx);
}
