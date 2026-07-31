// @archstone/init — D-9: the resource-emission decision procedure, and the required rule.
//
// ADD-37 §1.1 and §1.2, implemented as pure functions over the Draft Model so that both can be
// tested branch-by-branch without emitting a byte of YAML. They live in their own file because
// they are the two places where getting it wrong is expensive in DIFFERENT ways: D-9 wrong
// ships a manifest with the wrong shape (loud, caught by the compiler); §1.2 wrong ships a
// manifest that compiles, verifies green, and then VIOLATES on the first real null (silent,
// caught by a customer).
//
// The discipline both share, borrowed from the compiler's own resource-name resolution:
// AMBIGUOUS IS A REFUSAL, NEVER A GUESS.

import {
  isKnown,
  type DraftNode,
  type DraftObjectNode,
  type DraftProperty,
} from "./model";

/** A property name that is safe in dot notation. */
const SIMPLE_PROPERTY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Characters the bracket form cannot carry: `jsonpath-plus` does not honour a backslash
 *  escape inside `$['…']`, and an unescaped `'`/`[`/`]` ends the segment early. */
const BRACKET_HOSTILE = /['\\[\]]/;

/**
 * The JSONPath accessor for one property name, or `undefined` when none exists.
 *
 * Not cosmetic. `$.price.usd` does NOT read a key literally named `price.usd` — it navigates
 * two levels and resolves to nothing, and a mapping that resolves to nothing is reported by
 * the shipped mapper as a missing field forever after: a VIOLATION for a value the backend
 * has been returning all along. The bracket form handles dots, spaces, dashes, digits, quotes
 * and non-ASCII; nothing handles a `'`, a `\` or a `[`/`]`, so those are declined rather than
 * guessed at (checked against the real evaluator, not inferred from the spec).
 */
export function propertyAccessor(name: string): string | undefined {
  if (SIMPLE_PROPERTY.test(name)) return `.${name}`;
  if (BRACKET_HOSTILE.test(name)) return undefined;
  return `['${name}']`;
}

/**
 * ONE PLACE A RESPONSE COULD BE MAPPED FROM — a candidate, not a verdict (D-14).
 *
 * `id` is what the Decision Record selects with, and it is deliberately a plain string rather
 * than an index: an index would silently re-point at a different shape the day the document
 * gains a property, and a Decision Record is a file people keep.
 */
export interface LocusCandidate {
  /** `"root"`, or the collection JSONPath (`$.items[*]`). The Decision Record's selector. */
  id: string;
  kind: "root" | "collection";
  locus: DraftObjectNode;
  /** Set iff `kind === "collection"`. */
  collection?: string;
  /** The property the list came from; absent for a bare top-level array. */
  property?: string;
  /**
   * The scalar leaf names this locus would map, in order.
   *
   * Carried for the GATE, and that is not decoration: R-11 says the question's wording is
   * doing more work than the code, and a developer cannot answer "a list of X, or one X with
   * a list inside it?" from two JSONPaths alone. `$.warnings[*] (code, message)` versus
   * `root (quotedPrice, currency)` is answerable in a second; the paths alone are not.
   */
  fields: string[];
}

/** What the census found, plus the things that are worth reporting but are not candidates. */
export interface LocusCensus {
  /** Preference-free, in document order: the root first when it qualifies, then each
   *  array-of-objects property. NO ordering significance — the caller must not treat
   *  `candidates[0]` as an answer. */
  candidates: LocusCandidate[];
  /** JSONPaths a probe saw when nothing was describable. */
  observedPaths?: string[];
  /** Collection properties no JSONPath can address, so they could not become candidates. */
  unaddressable: string[];
}

/** Is this node an array whose items are objects — i.e. a candidate item collection? */
function arrayOfObjectsItems(node: DraftNode): DraftObjectNode | undefined {
  return node.kind === "array" && node.items.kind === "object" ? node.items : undefined;
}

/** The scalar leaves of an object node that a JSONPath can actually address. */
function mappableScalarNames(locus: DraftObjectNode): string[] {
  return locus.properties.filter((p) => p.node.kind === "scalar" && propertyAccessor(p.name) !== undefined).map((p) => p.name);
}

/**
 * D-14 — enumerate every place the response could be mapped from, WITH NO PREFERENCE.
 *
 * This replaces §1.1 step 1's single verdict, and the reason is O-21: an object root carrying
 * scalar payload plus one incidental array is STRUCTURALLY IDENTICAL to a paginated list
 * wrapper. `PartList` is `{items[], total, page, limit}` and `PartQuote` is
 * `{warnings[], quotedPrice, currency}` — one array-of-objects, scalar siblings, the array
 * declared required, in both. No OpenAPI construct and no property of the Draft Model
 * distinguishes them; only the NAMES do, and name-based inference is what this increment
 * refuses (a blocklist of `warnings`/`errors`/`meta` is a guess with a bibliography, and it is
 * unbounded by construction).
 *
 * The old branch order resolved that overlap by picking the array — a preference dressed as a
 * procedure — which shipped a price capability whose entire output was a list of warnings.
 * Enumerating and asking is the disposition this ADD already uses for every other genuine
 * choice: `effect`, the resource name, `sampleInput`.
 */
export function locusCandidates(response: DraftNode): LocusCensus {
  const candidates: LocusCandidate[] = [];
  const unaddressable: string[] = [];

  const topLevelItems = arrayOfObjectsItems(response);
  if (topLevelItems) {
    // A bare top-level array has exactly one possible reading, so no question is ever asked.
    candidates.push({ id: "$[*]", kind: "collection", locus: topLevelItems, collection: "$[*]", fields: mappableScalarNames(topLevelItems) });
    return { candidates, unaddressable };
  }

  if (response.kind === "object") {
    // The root qualifies iff it has at least one addressable scalar leaf. An object of nothing
    // but nested objects would produce an empty `map:`, which the shipped response schema
    // rejects (`minProperties: 1`).
    const rootFields = mappableScalarNames(response);
    if (rootFields.length > 0) {
      candidates.push({ id: "root", kind: "root", locus: response, fields: rootFields });
    }

    for (const property of response.properties) {
      const items = arrayOfObjectsItems(property.node);
      if (!items) continue;
      const accessor = propertyAccessor(property.name);
      if (accessor === undefined) {
        // A distinct fact from "there was no collection", and one the report must state
        // rather than round down to "no shape".
        unaddressable.push(property.name);
        continue;
      }
      const collection = `$${accessor}[*]`;
      candidates.push({ id: collection, kind: "collection", locus: items, collection, property: property.name, fields: mappableScalarNames(items) });
    }
    return { candidates, unaddressable };
  }

  if (response.kind === "unknown" && response.observedPaths && response.observedPaths.length > 0) {
    return { candidates, unaddressable, observedPaths: response.observedPaths };
  }
  return { candidates, unaddressable };
}

/** The outcome of resolving a census against the Decision Record's answer. */
export type LocusSelection =
  /** Exactly what will be mapped. */
  | { kind: "selected"; candidate: LocusCandidate; /** True when no question needed asking. */ sole: boolean }
  /** A choice exists and the Decision Record does not resolve it ⇒ skip the operation. */
  | { kind: "ambiguous"; candidates: LocusCandidate[]; supplied?: string }
  /** Nothing mappable at all ⇒ the honest degraded path. */
  | { kind: "none" };

/**
 * D-14's selection half. THE EMITTER READS THIS, NEVER THE CENSUS.
 *
 * `candidates : responseLocus :: effectHint : effect` — the census proposes, the human
 * decides, and the pure emitter can only see the decision. That is D-3's discipline applied a
 * third time, and it is precisely what keeps this from being branch order with extra steps: if
 * `emit` could re-derive a preferred candidate, the question would be decorative.
 *
 * ONE HONEST LIMIT, stated rather than glossed: unlike `effect`, this CANNOT be type-enforced.
 * `effect` is unconditionally required on the `keep: true` arm, so a discriminated union
 * makes "no effect without confirmation" a property of the type. The locus obligation is
 * conditional on response shape, and a union cannot express "required iff the adapter found
 * two or more candidates". The enforcement is the refusal below, and the refusal is what the
 * tests assert.
 */
export function selectLocus(census: LocusCensus, responseLocus: string | undefined): LocusSelection {
  const { candidates } = census;
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "selected", candidate: candidates[0]!, sole: true };

  if (responseLocus === undefined) return { kind: "ambiguous", candidates };
  const chosen = candidates.find((c) => c.id === responseLocus);
  // A selector that matches nothing is NOT a fallback to the pre-fill: a Decision Record
  // written against a document that has since changed must refuse, exactly as
  // `unknown-candidate` does one level up, rather than silently answer a different question.
  if (!chosen) return { kind: "ambiguous", candidates, supplied: responseLocus };
  return { kind: "selected", candidate: chosen, sole: false };
}

/** A mappable leaf of the item locus: one resource field ← one JSONPath. */
export interface LocusLeaf {
  property: DraftProperty;
  /** JSONPath into a single item, relative to `collection` (or the body root). */
  path: string;
}

/**
 * D-9 step 2 — depth: scalar leaves at depth ≤ 1 relative to the locus, ONLY.
 *
 * A nested object (or a nested array) is neither flattened nor promoted to a second resource:
 * it needs its own resource NAME, and no name matching the shipped grammar is safely derivable
 * from a property called `details`. Inventing one is the naming inference this increment
 * defers. **Exactly one resource per capability, always — never several, never
 * zero-with-an-output.**
 *
 * This is an EMISSION restriction, not a capability limit: the shipped mapper evaluates
 * arbitrary JSONPaths, so a human can deepen the map by hand afterwards. The report says so.
 */
export function locusLeaves(locus: DraftObjectNode): {
  leaves: LocusLeaf[];
  nested: DraftProperty[];
  /** Scalar leaves no JSONPath can address (see `propertyAccessor`). Left OUT of the map
   *  rather than mapped to a path that silently resolves to nothing. */
  unaddressable: DraftProperty[];
} {
  const leaves: LocusLeaf[] = [];
  const nested: DraftProperty[] = [];
  const unaddressable: DraftProperty[] = [];
  for (const property of locus.properties) {
    if (property.node.kind !== "scalar") {
      nested.push(property);
      continue;
    }
    const accessor = propertyAccessor(property.name);
    if (accessor === undefined) unaddressable.push(property);
    else leaves.push({ property, path: `$${accessor}` });
  }
  return { leaves, nested, unaddressable };
}

/**
 * HOW non-nullability was established, which a boolean cannot carry (Amendment 1 §A-3).
 *
 * The distinction that matters is *known-false* versus *unknown*, and the shipped code
 * collapsed them: `isKnown(nullable) ? value : false` read silence as "not nullable". For a
 * well-formed 3.1 or 3.0 document that is right by accident, not by construction — and it is
 * wrong exactly where an adapter could not determine nullability (an unresolved `$ref`, an
 * unreduced `oneOf`, a composition conflict). There, silence collapsed to `required: true`,
 * and O-6 makes that the direction that ships a VIOLATION the first time the backend tells
 * the truth.
 */
export type NullabilityEvidence =
  /** A source stated the field may be null. */
  | { kind: "declared-nullable" }
  /** A source POSITIVELY established that it may not — a `type` excluding `null`, a resolved
   *  3.0 schema without `nullable: true`. Not the same as "the source said nothing". */
  | { kind: "declared-non-nullable" }
  /** No declaration, but every one of `items` recorded items carried a non-null value. */
  | { kind: "observed-non-null"; items: number }
  /** Nobody knows. The member the old boolean could not express. */
  | { kind: "unknown"; reason?: string };

/** How a field's required/optional classification was reached — carried into the report so the
 *  difference between a measurement and a claim stays visible. */
export type RequiredBasis =
  /** A source document declared required-ness (possibly corroborated or contradicted by
   *  observation). `nullability` says what the second half of the rule rested on. */
  | { kind: "declared"; nullability: NullabilityEvidence; observedItems?: number }
  /** Observation only: `required` iff present and non-null in EVERY item seen. */
  | { kind: "observational"; items: number; presentNonNull: number }
  /** Nothing is known — `required: false`, because the alternative is a manifest that VIOLATES
   *  on the first real null. */
  | { kind: "unknown" };

export interface RequiredClassification {
  required: boolean;
  basis: RequiredBasis;
}

/**
 * D-12 (Amendment 1 §A-3) — the one rule that must not be gotten wrong, restated once.
 *
 *     `required: true` demands POSITIVE EVIDENCE OF NON-NULLABILITY.
 *     That evidence is either a DECLARATION (`nullable` known false) or an OBSERVATION
 *     (`presentNonNull === items`, `items > 0`). Absent both, `required: false`.
 *
 * This subsumes §1.2's original box rather than contradicting it, and closes the case that box
 * could not see: declared-required + nullability *unknown* + no probe now yields **false**,
 * where it used to yield true.
 *
 * Why the nullability clause is load-bearing at all (O-6): `@archstone/emitter-support`'s
 * response mapper treats `null` IDENTICALLY to `undefined`, so a field marked required in the
 * resource that comes back `null` is a contract VIOLATION — not a DEGRADED. A nullable field
 * marked required therefore ships a manifest that fails the first time the backend tells the
 * truth, and getting the direction wrong is the expensive half.
 *
 * THE ADAPTER OBLIGATION IS THE LOAD-BEARING HALF. An adapter must set
 * `nullable: declared(false)` whenever its source POSITIVELY establishes non-nullability, and
 * leave it absent only when it genuinely could not tell. An adapter that leaves `nullable`
 * absent everywhere makes every field optional here — which is visibly wrong in the diff
 * harness (DoD-3d), the right place for that mistake to land.
 *
 * A `declaredRequired` fact whose derivation is `observed` is deliberately NOT treated as a
 * declaration: presence in a payload is evidence, and evidence belongs in `presence`, where
 * the sample size travels with it.
 */
export function classifyRequired(property: DraftProperty): RequiredClassification {
  const nullableFact = property.node.kind === "scalar" ? property.node.nullable : undefined;
  const declaredNullable = nullableFact !== undefined && isKnown(nullableFact) && nullableFact.value === true;
  const declaredNonNullable = nullableFact !== undefined && isKnown(nullableFact) && nullableFact.value === false;

  const presence = property.presence;
  const observedAlwaysPresent = presence !== undefined && presence.items > 0 && presence.presentNonNull === presence.items;

  // The positive evidence D-12 demands. Note the asymmetry, which is the whole point: a
  // DECLARATION of nullability is disqualifying on its own, but the absence of one proves
  // nothing and therefore grants nothing.
  const nonNullEvidence: NullabilityEvidence = declaredNullable
    ? { kind: "declared-nullable" }
    : declaredNonNullable
      ? { kind: "declared-non-nullable" }
      : observedAlwaysPresent
        ? { kind: "observed-non-null", items: presence!.items }
        : {
            kind: "unknown",
            ...(nullableFact !== undefined && nullableFact.derivation === "absent" && nullableFact.reason !== undefined
              ? { reason: nullableFact.reason }
              : {}),
          };
  const positiveEvidence = nonNullEvidence.kind === "declared-non-nullable" || nonNullEvidence.kind === "observed-non-null";

  if (property.declaredRequired.derivation === "declared") {
    // `(presence === undefined || observedAlwaysPresent)` survives from §1.2: a probe that saw
    // the field missing or null on even one item overrides a declaration that says otherwise.
    const required = property.declaredRequired.value && positiveEvidence && (presence === undefined || observedAlwaysPresent);
    return {
      required,
      basis: { kind: "declared", nullability: nonNullEvidence, ...(presence !== undefined ? { observedItems: presence.items } : {}) },
    };
  }

  if (presence !== undefined) {
    // The observational branch is untouched by D-12: an observed-always-non-null field still
    // classifies required under UNKNOWN declared nullability, because the observation IS the
    // positive evidence. A declared nullability of `true` still disqualifies it.
    return {
      required: observedAlwaysPresent && !declaredNullable,
      basis: { kind: "observational", items: presence.items, presentNonNull: presence.presentNonNull },
    };
  }

  return { required: false, basis: { kind: "unknown" } };
}
