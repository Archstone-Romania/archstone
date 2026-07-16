// @archstone/compiler — Resource name resolution (P-7).
//
// The single source of truth for turning a `ref`/`collection`/resource-typed name
// into its canonical, domain-qualified form. Used by BOTH the semantic validator
// (which reports unresolved/ambiguous names) and the compiler (which canonicalizes
// names before they reach the IR). Neutral: no MCP, no JSON Schema, no HTTP.
//
// P-7 (RFC-0001 §4 P3 / four-domains): a resource name is domain-qualified
// (`tourism.Stay`); a BARE name (`Stay`) is same-domain shorthand for the referring
// capability's/resource's domain. Cross-domain references MUST be qualified. A bare
// name that matches BOTH a same-domain resource and a bare-named resource is ambiguous
// — an error, never a silent guess (SD-2 payment).

import { SEMANTIC_TYPES, type SemanticType } from "./ir";

/** The domain prefix of a capability id or qualified resource name (`tourism.search` → `tourism`). */
export function domainOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? "" : name.slice(0, dot);
}

/** The resource name a field references, if any (`collection`/`ref`/capitalized `type`). */
export function referencedResourceName(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.collection === "string") return raw.collection;
  if (typeof raw.ref === "string") return raw.ref;
  if (typeof raw.type === "string" && !SEMANTIC_TYPES.has(raw.type as SemanticType)) return raw.type;
  return undefined;
}

export type Resolution =
  | { ok: true; canonical: string }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; candidates: [string, string] };

/**
 * Resolve `ref` (as written in a field) to a canonical registry name, per P-7.
 * `domain` is the referring capability's/resource's domain; `index` holds every
 * loaded resource's canonical name (as authored).
 */
export function resolveResourceName(ref: string, domain: string, index: ReadonlySet<string>): Resolution {
  if (ref.includes(".")) {
    // Already qualified — must match exactly. Cross-domain refs land here.
    return index.has(ref) ? { ok: true, canonical: ref } : { ok: false, reason: "unknown" };
  }
  const qualified = domain ? `${domain}.${ref}` : "";
  const hasQualified = qualified !== "" && index.has(qualified);
  const hasBare = index.has(ref);
  if (hasQualified && hasBare) return { ok: false, reason: "ambiguous", candidates: [qualified, ref] };
  if (hasQualified) return { ok: true, canonical: qualified };
  if (hasBare) return { ok: true, canonical: ref };
  return { ok: false, reason: "unknown" };
}

/** The set of canonical resource names present in a model's resource docs. */
export function resourceIndex(resourceDocs: { resource: { name: string } }[]): Set<string> {
  return new Set(resourceDocs.map((d) => d.resource.name));
}
