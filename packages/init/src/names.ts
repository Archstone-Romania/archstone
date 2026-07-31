// @archstone/init — the only place a name is derived, and the grammars it must satisfy.
//
// Every pattern below is COPIED from the shipped schemas rather than approximated, because a
// name that almost matches produces a file the loader rejects, which under D-7 means the whole
// run writes nothing. Names are also the axis the ArtVinci diff explicitly excludes from its
// pass criterion (D-8) — so this file is allowed to be plain, and must never be clever.

/** `capabilities.schema.json` — `company.id`, and each `providers[]` entry. */
export const COMPANY_ID_RE = /^[a-z][a-z0-9-]*$/;
/** `cdl.schema.json` — a capability id: `domain.action`, at least two segments. */
export const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/** `cdl.schema.json#/$defs/resourceName` — optionally domain-qualified PascalCase. */
export const RESOURCE_NAME_RE = /^([a-z][a-z0-9-]*\.)?[A-Z][A-Za-z0-9]*$/;

/** The domain half of a capability id (`framing.list-frame-profiles` → `framing`). */
export function domainOfCapabilityId(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? "" : id.slice(0, dot);
}

/** The local (unqualified) half of a resource name (`framing.FrameProfile` → `FrameProfile`). */
export function localResourceName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/** Qualify a bare resource name with a domain; an already-qualified name passes through. */
export function qualifyResourceName(name: string, domain: string): string {
  if (name.includes(".") || domain === "") return name;
  return `${domain}.${name}`;
}

/** PascalCase a source-supplied token (`frame_profile` / `frame-profile` → `FrameProfile`).
 *  Returns `undefined` when the result is not a legal resource name — never a mangled one. */
export function toResourceLocalName(raw: string): string | undefined {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  if (parts.length === 0) return undefined;
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return RESOURCE_NAME_RE.test(pascal) ? pascal : undefined;
}

/**
 * The crudest possible singularization, and deliberately so: `-ies` → `-y`, `-ses` → `-s`,
 * trailing `-s` dropped. An English-language pluralization library would be a second guessing
 * engine in a tool whose entire pitch is that it does not guess — and D-9 step 3 already has
 * the right answer for everything this misses: ask the human, who is standing right there.
 */
export function singularize(word: string): string {
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** camelCase a token, for an output field name (`FrameProfile` → `frameProfile`). */
export function toCamelCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  if (parts.length === 0) return raw;
  const [first, ...rest] = parts;
  const head = first!.charAt(0).toLowerCase() + first!.slice(1);
  return head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/**
 * The output field a mapped resource lands under.
 *
 * Derived from the RESOURCE name, not from the provider's property name, so that one rule
 * covers every source: `framing.FrameProfile` → `frameProfiles` for a collection,
 * `framePriceEstimate` for a single object. `outputFieldFor` in the compiler binds the response
 * mapping to whichever output field references the mapped resource, and there is exactly one —
 * which is what keeps that binding unambiguous by construction (O-9).
 */
export function outputFieldName(resourceName: string, collection: boolean): string {
  const local = toCamelCase(localResourceName(resourceName));
  return collection ? `${local}s` : local;
}

/** The env-var placeholder form the shipped manifests use for a backend base URL. */
export function envPlaceholder(varName: string): string {
  return `\${${varName}}`;
}
