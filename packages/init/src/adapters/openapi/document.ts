// The OpenAPI adapter — documents and `$ref` resolution (ADD-37 Amendment 1 D-11).
//
// OPENAPI KNOWLEDGE LIVES ONLY UNDER `adapters/`, and this file is where most of it is. It
// parses whatever bytes the host handed over, resolves JSON Pointers within a document and
// across documents, and answers "which other files do I still need" — which is the one
// question `SourceAdapter.references()` exists to ask.
//
// PURE. It reads no file and opens no socket: every document it can see arrived in
// `SourceInput.document` / `SourceInput.documents`. That is what keeps `adapt()` synchronous,
// total and re-runnable, which a tool whose pitch is "put it in CI and diff the result" cannot
// do without.

import { parse as parseYaml } from "yaml";

/** A parsed document, plus the key it is filed under. */
export interface LoadedDocument {
  /** `""` for the primary input document; otherwise its path relative to the primary's
   *  directory, POSIX-normalized — the same string `references()` returns and the same key the
   *  host files the bytes under. */
  key: string;
  root: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** The primary document's key. Empty rather than a filename, because the adapter is never told
 *  a filename — only `origin`, which is for the report and is never dereferenced. */
export const PRIMARY = "";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse YAML or JSON, or return `undefined`.
 *
 * `yaml` parses JSON as a subset, so one call covers both — a `.json` spec needs no branch.
 * Never throws: a malformed document is a report line, not a stack trace (the `SourceAdapter`
 * contract's "never throws for unsupported input" half).
 */
export function parseDocument(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = parseYaml(text);
    return parsed === undefined ? undefined : (parsed as JsonValue);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a document-relative path against the document that referenced it.
 *
 * POSIX-only and deliberately strict: `..` is refused outright rather than normalized, because
 * the host's contract is "same directory subtree only — no URL, no network, no `..` escape",
 * and a resolver that quietly climbs out of the subtree turns a spec file into an arbitrary
 * file-read primitive.
 */
export function resolveDocumentKey(fromKey: string, target: string): string | undefined {
  if (target === "") return undefined;
  const baseParts = fromKey === PRIMARY ? [] : fromKey.split("/").slice(0, -1);
  const parts = [...baseParts, ...target.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined; // never climbs, never normalizes away
    out.push(part);
  }
  return out.length === 0 ? undefined : out.join("/");
}

/** A `$ref` split into the document it names (if any) and the JSON Pointer inside it. */
export interface ParsedRef {
  /** `undefined` ⇒ same document. */
  document?: string;
  pointer: string;
  /** A URL, or anything else this adapter will not fetch. */
  remote: boolean;
}

const REMOTE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function parseRef(ref: string): ParsedRef {
  if (REMOTE_RE.test(ref)) return { pointer: "", remote: true };
  const hash = ref.indexOf("#");
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  return { ...(file === "" ? {} : { document: file }), pointer, remote: false };
}

/** Walk a JSON Pointer (`/components/schemas/Foo`). Returns `undefined` for any miss. */
export function derefPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "" || pointer === "/") return root;
  let node: JsonValue | undefined = root;
  for (const rawSegment of pointer.replace(/^\//, "").split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isObject(node)) node = node[segment];
    else if (Array.isArray(node)) node = node[Number(segment)];
    else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** Every document the adapter currently holds, keyed as above. */
export class DocumentSet {
  private readonly docs = new Map<string, JsonValue>();
  /** Keys that were supplied but could not be parsed — a different failure from "not supplied". */
  readonly unparsable: string[] = [];

  constructor(primary: string | undefined, others: Record<string, string> | undefined) {
    if (primary !== undefined) {
      const parsed = parseDocument(primary);
      if (parsed === undefined) this.unparsable.push(PRIMARY);
      else this.docs.set(PRIMARY, parsed);
    }
    for (const [key, text] of Object.entries(others ?? {})) {
      const parsed = parseDocument(text);
      if (parsed === undefined) this.unparsable.push(key);
      else this.docs.set(key, parsed);
    }
  }

  has(key: string): boolean {
    return this.docs.has(key);
  }

  /** Every document key currently held, primary first. */
  keys(): string[] {
    return [...this.docs.keys()];
  }

  get(key: string): JsonValue | undefined {
    return this.docs.get(key);
  }

  get primary(): JsonValue | undefined {
    return this.docs.get(PRIMARY);
  }
}

/** A resolved `$ref` target: the node, and which document it lives in (so a nested `$ref`
 *  inside it resolves against the RIGHT document, not against the one that pointed here). */
export interface Resolved {
  node: JsonValue;
  docKey: string;
  /** `<docKey>#<pointer>` — the identity used for cycle detection and for the component name. */
  id: string;
}

export type ResolveFailure = "remote" | "missing-document" | "missing-pointer" | "escapes-subtree";

export function resolveRef(docs: DocumentSet, fromDocKey: string, ref: string): Resolved | ResolveFailure {
  const parsed = parseRef(ref);
  if (parsed.remote) return "remote";

  let docKey = fromDocKey;
  if (parsed.document !== undefined) {
    const resolved = resolveDocumentKey(fromDocKey, parsed.document);
    if (resolved === undefined) return "escapes-subtree";
    docKey = resolved;
  }
  const root = docs.get(docKey);
  if (root === undefined) return "missing-document";
  const node = derefPointer(root, parsed.pointer);
  if (node === undefined) return "missing-pointer";
  return { node, docKey, id: `${docKey}#${parsed.pointer}` };
}

/**
 * Every OTHER document reachable by `$ref` from what we currently hold, whether or not we have
 * it yet.
 *
 * A whole-document scan rather than a scan of only the parts we lower: `references()` runs
 * before any lowering, and an adapter that asked for its documents lazily would need one host
 * round-trip per nesting level of an arbitrary spec. The host caps the iterations regardless.
 */
export function collectDocumentReferences(docs: DocumentSet): string[] {
  const found = new Set<string>();
  for (const key of docs.keys()) {
    const root = docs.get(key);
    if (root === undefined) continue;
    walk(root, (ref) => {
      const parsed = parseRef(ref);
      if (parsed.remote || parsed.document === undefined) return;
      const resolved = resolveDocumentKey(key, parsed.document);
      if (resolved !== undefined) found.add(resolved);
    });
  }
  return [...found].sort();
}

function walk(node: JsonValue, onRef: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, onRef);
    return;
  }
  if (!isObject(node)) return;
  const ref = node["$ref"];
  if (typeof ref === "string") onRef(ref);
  for (const value of Object.values(node)) walk(value, onRef);
}
