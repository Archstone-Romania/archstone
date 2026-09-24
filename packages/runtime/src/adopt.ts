// @archstone/runtime — Adoption planner (ADD-117 / ADR-0008).
//
// Turns a field ADD-114's drift NAMED into a field the manifest DECLARES. This module is the
// pure half: it decides what could be adopted and why each rejected candidate was rejected.
// It touches no disk, asks no human, and mutates nothing — the CLI owns all three (D-6), which
// is what lets every rule below be tested without a temp directory or a terminal.
//
// The rules exist because ADR-0008 draws a hard line: an undeclared field never reaches a
// model. Adoption is the ONLY way across that line, and it is deliberately a human act.

import type { IRTool, IRResourceRegistry, JsonType, SemanticType, ShapeDiff } from "@archstone/compiler";

/** Why a named path cannot be adopted. Stated, never silently skipped — a candidate that
 *  disappears from the report reads as "there was nothing there". */
export type AdoptionRefusal =
  | "outside-collection"
  | "nested"
  | "no-boolean-type"
  | "not-a-leaf"
  | "already-declared"
  /** #82 (ADD-12 §8.2): an observed array field whose elements are objects. Distinct from
   *  `not-a-leaf` — an object array needs a declared row/resource shape to adopt into, which
   *  this increment does not ratify (§8.4 founder ruling: "deferred — ADD ulterior"; core #49
   *  is where that reopens). */
  | "array-of-objects-unresolved";

export interface AdoptableField {
  adoptable: true;
  /** The JSONPath the drift reported, e.g. `$.stays[].boardType`. */
  path: string;
  /** The resource field name (inside the collection) or output field name (outside it, #82)
   *  it would become, e.g. `boardType` or `warnings`. */
  field: string;
  /** The path written into the binding's `response.map` (relative to the collection item) or,
   *  for a #82 scalar-array candidate, into `extract:` (body-root, all-matches — `$.foo[*]`). */
  itemPath: string;
  observed: JsonType;
  /** What it is declared as. See ADD-117 §3 — the table is deliberately dull. For a #82
   *  scalar-array candidate, this is the ELEMENT's semantic type (`list: <semantic>`, not
   *  `type: <semantic>` — the field itself is an array). */
  semantic: SemanticType;
}

export interface UnadoptableField {
  adoptable: false;
  path: string;
  observed: JsonType;
  reason: AdoptionRefusal;
  /** One sentence an operator can act on, or at least understand. */
  detail: string;
}

export type AdoptionCandidate = AdoptableField | UnadoptableField;

export interface AdoptionPlan {
  capabilityId: string;
  /** The resource the binding's `response:` maps onto — the file a field would be added to. */
  resource?: string;
  candidates: AdoptionCandidate[];
}

/**
 * ADD-117 §3. An observed JSON type becomes exactly one CDL semantic type, or nothing.
 *
 * Deliberately NOT clever. `string` does not become `date` however much a value looked like
 * one, because the shape records types and never values — there is nothing here to
 * pattern-match, and inferring a date from a field NAME is exactly the guess this project
 * refuses to make. `number` does not become `money`, because whether a number is a price is a
 * business fact and `money` carries a currency this field does not have. The human can widen
 * either afterwards; the manifest is theirs.
 */
function semanticFor(observed: JsonType): SemanticType | undefined {
  if (observed === "string") return "text";
  if (observed === "number") return "quantity";
  return undefined;
}

function refusalDetail(reason: AdoptionRefusal, observed: JsonType): string {
  switch (reason) {
    case "outside-collection":
      return "outside the collection this capability maps; it is not a field of the resource";
    case "nested":
      return "nested, or a provider key containing a dot — indistinguishable here; either way the resource field would have to be another resource, which adoption does not create";
    case "no-boolean-type":
      return "CDL has no boolean semantic type, and declaring it as text would state a lie about the shape";
    case "not-a-leaf":
      return `observed as ${observed}, which is a structure rather than a value`;
    case "already-declared":
      return "already declared by this capability";
    case "array-of-objects-unresolved":
      return "an array of objects needs a declared row/resource shape to adopt into, which core #49 (lifting the one-output-field cap) has not ratified yet — declare it by hand once that lands";
  }
}

/**
 * The path prefix every field of one collection item shares.
 *
 * A binding's `collection` is a JSONPath over the payload (`$.stays[*]`); a recorded shape
 * flattens an array to its first element (`$.stays[]`). One translation, here, rather than two
 * conventions leaking into every comparison below. A capability with no `collection` maps a
 * single object, whose fields hang off the root.
 */
function itemPrefix(collection: string | undefined): string {
  if (!collection) return "$";
  return collection.replace(/\[\*\]/g, "[]");
}

/**
 * What could be declared, and why the rest could not.
 *
 * Only `drift.added` is considered: `removed` is a loss with nothing to declare, and `retyped`
 * needs a judgment no shape comparison can make — is `price_per_night` the old `pricePerNight`,
 * or a new field that happens to look like it? ADR-0008 puts both out of scope, and the diff
 * still names them so a human can act.
 */
export function planAdoption(tool: IRTool, drift: ShapeDiff, resources: IRResourceRegistry): AdoptionPlan {
  const mapping = tool.response;
  if (!mapping) return { capabilityId: tool.id, candidates: [] };

  const prefix = itemPrefix(mapping.collection);
  const declared = new Set<string>([
    ...mapping.fields.map((f) => f.name),
    ...(resources[mapping.resource] ?? []).map((f) => f.name),
  ]);
  const declaredOutput = new Set<string>(tool.output.map((f) => f.name));

  const refuse = (path: string, observed: JsonType, reason: AdoptionRefusal): UnadoptableField => ({
    adoptable: false,
    path,
    observed,
    reason,
    detail: refusalDetail(reason, observed),
  });

  // #82 (ADD-12 §8.2): `path[]` element-detail entries (the SAME flattening `describeShape`
  // records for any array) tell us what an outside-collection array's items look like, without
  // a second traversal. Consumed below, keyed by the array's own path — never offered as a
  // candidate in their own right when they explain one.
  const elementTypeOf = new Map<string, JsonType>();
  for (const { path, type } of drift.added) {
    if (path.endsWith("[]")) elementTypeOf.set(path.slice(0, -2), type);
  }

  const candidates: AdoptionCandidate[] = [];
  for (const { path, type: observed } of drift.added) {
    const outsideCollection = !path.startsWith(`${prefix}.`);

    if (outsideCollection && observed === "array") {
      // A field at (or reachable from) the response root, not the mapped collection — #82:
      // an array of ONE scalar semantic type is adoptable via `extract:`; an array of objects
      // is refused, distinct from `not-a-leaf`, naming that it needs a declared row shape.
      const field = path.replace(/^\$\.?/, "").split(".").pop() ?? path;
      if (declaredOutput.has(field)) {
        candidates.push(refuse(path, observed, "already-declared"));
        continue;
      }
      const elementType = elementTypeOf.get(path);
      if (elementType === "object") {
        candidates.push(refuse(path, observed, "array-of-objects-unresolved"));
        continue;
      }
      const semantic = elementType ? semanticFor(elementType) : undefined;
      if (!semantic) {
        // No element observed yet (empty array) or an element type CDL has no semantic for
        // (e.g. boolean) — not enough to confidently declare an element type.
        candidates.push(refuse(path, observed, "not-a-leaf"));
        continue;
      }
      candidates.push({ adoptable: true, path, field, itemPath: `${path}[*]`, observed, semantic });
      continue;
    }

    // The element-detail entry for an outside-collection array (`path[]`) is consumed above,
    // keyed by the array's own path — it explains that verdict and is never offered/refused a
    // second time as its own, duplicate candidate.
    if (outsideCollection && path.endsWith("[]") && elementTypeOf.get(path.slice(0, -2)) === observed) {
      const arrayPath = path.slice(0, -2);
      if (!arrayPath.startsWith(`${prefix}.`)) continue;
    }

    if (outsideCollection) {
      candidates.push(refuse(path, observed, "outside-collection"));
      continue;
    }
    const rest = path.slice(prefix.length + 1);
    if (rest.includes("[")) {
      candidates.push(refuse(path, observed, "nested"));
      continue;
    }
    // A dot here is either a nested object (`address.city`) or a single provider key that
    // contains a dot. Those two are INDISTINGUISHABLE in this flattened space — the same
    // collision `describeShape` documents — so there is one refusal, not a coin flip between
    // two, and its detail says so. Either way the answer is the same: not adopted.
    if (rest.includes(".")) {
      candidates.push(refuse(path, observed, "nested"));
      continue;
    }
    if (observed === "boolean") {
      candidates.push(refuse(path, observed, "no-boolean-type"));
      continue;
    }
    const semantic = semanticFor(observed);
    if (!semantic) {
      candidates.push(refuse(path, observed, "not-a-leaf"));
      continue;
    }
    if (declared.has(rest)) {
      candidates.push(refuse(path, observed, "already-declared"));
      continue;
    }
    candidates.push({ adoptable: true, path, field: rest, itemPath: `$.${rest}`, observed, semantic });
  }

  return { capabilityId: tool.id, resource: mapping.resource, candidates };
}

/** The adoptable candidates, in the order they would be offered. */
export function adoptable(plan: AdoptionPlan): AdoptableField[] {
  return plan.candidates.filter((c): c is AdoptableField => c.adoptable);
}
