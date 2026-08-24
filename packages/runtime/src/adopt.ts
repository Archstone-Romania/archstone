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
  | "already-declared";

export interface AdoptableField {
  adoptable: true;
  /** The JSONPath the drift reported, e.g. `$.stays[].boardType`. */
  path: string;
  /** The resource field name it would become, e.g. `boardType`. */
  field: string;
  /** The path written into the binding's `response.map`, relative to the collection item. */
  itemPath: string;
  observed: JsonType;
  /** What it is declared as. See ADD-117 §3 — the table is deliberately dull. */
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

  const refuse = (path: string, observed: JsonType, reason: AdoptionRefusal): UnadoptableField => ({
    adoptable: false,
    path,
    observed,
    reason,
    detail: refusalDetail(reason, observed),
  });

  const candidates = drift.added.map<AdoptionCandidate>(({ path, type: observed }) => {
    if (!path.startsWith(`${prefix}.`)) return refuse(path, observed, "outside-collection");
    const rest = path.slice(prefix.length + 1);
    if (rest.includes("[")) return refuse(path, observed, "nested");
    // A dot here is either a nested object (`address.city`) or a single provider key that
    // contains a dot. Those two are INDISTINGUISHABLE in this flattened space — the same
    // collision `describeShape` documents — so there is one refusal, not a coin flip between
    // two, and its detail says so. Either way the answer is the same: not adopted.
    if (rest.includes(".")) return refuse(path, observed, "nested");
    if (observed === "boolean") return refuse(path, observed, "no-boolean-type");
    const semantic = semanticFor(observed);
    if (!semantic) return refuse(path, observed, "not-a-leaf");
    if (declared.has(rest)) return refuse(path, observed, "already-declared");
    return { adoptable: true, path, field: rest, itemPath: `$.${rest}`, observed, semantic };
  });

  return { capabilityId: tool.id, resource: mapping.resource, candidates };
}

/** The adoptable candidates, in the order they would be offered. */
export function adoptable(plan: AdoptionPlan): AdoptableField[] {
  return plan.candidates.filter((c): c is AdoptableField => c.adoptable);
}
