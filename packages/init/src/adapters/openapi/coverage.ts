// The coverage guard — "present in the document but not understood" must not be silent.
//
// WHY THIS FILE EXISTS. `requestBody` was invisible for one structural reason: every OpenAPI
// object in this adapter is read by DIRECT STRING INDEXING of the keys it happens to know
// (`operation["parameters"]`, `operation["responses"]`, …). Nothing ever enumerated an object's
// keys, so an unhandled key was not merely unreported — it was never OBSERVED. The adapter could
// not have told anyone "your spec uses `requestBody` and I ignored it", because at no point did
// it hold that string.
//
// THE INVERSION, which is the whole point. The lists below are of keys the adapter READS and of
// keys it has a WRITTEN REASON to consider inert. Everything else — including a key nobody has
// thought of, a key from a future OpenAPI revision, and a key someone forgets to add here when
// they add a feature — falls through to a note. The default is loud. Had this existed,
// `requestBody` would have been a report line on day one instead of a silent empty `input:`.
//
// THREE TIERS, and the middle one is the dangerous one:
//   - READ      — the adapter indexes it and acts on it.
//   - INERT     — it cannot change what the emitted manifest says. Every member carries its own
//                 justification, because "surely that one does not matter" is precisely the
//                 reasoning that lost `requestBody`. If a key's inertness needs a paragraph, it
//                 is not inert.
//   - anything else → `source-construct-not-read`, a NON-skipping note naming the key.
//
// WHY NON-SKIPPING BY DEFAULT. Escalating every unread key to an operation skip would refuse
// nearly every real spec (they all carry `tags`), and a guard that refuses everything gets
// deleted. The guard's job is to end the SILENCE, not the emission. Where an unread key can make
// the emitted manifest actively WRONG rather than merely incomplete, it gets a specific refusal
// instead — see `SILENTLY_WRONG` below, which is the short, argued list.
//
// Vendor extensions (`x-…`) are excluded by definition: they are out-of-band by construction and
// no adapter is expected to read them.

import { note, type Note, type NoteScope } from "../../reasons";
import { isObject, type JsonObject } from "./document";

/** OpenAPI's own escape hatch. Out of band by construction — not a gap. */
const VENDOR_EXTENSION = /^x-/i;

export interface KeyPolicy {
  /** What this object is, in the note's words. */
  what: string;
  /** Keys the adapter indexes and acts on. */
  read: readonly string[];
  /** Keys that cannot change the emitted manifest. Each justified at its declaration. */
  inert: readonly string[];
  /**
   * Keys whose call site raises its OWN, more specific note or refusal.
   *
   * Not a third way of saying "ignored" — the opposite. A generic
   * `source-construct-not-read` beside a named refusal is strictly worse than the refusal
   * alone: it reports the same fact twice, in weaker words, and pads the group the reader is
   * meant to scan. So the specific disposition wins and this list records where.
   */
  refusedElsewhere: readonly string[];
}

/**
 * Keys whose presence makes the emitted manifest WRONG, not merely incomplete.
 *
 * The bar for membership is specific: ignoring the key produces a binding that compiles, serves,
 * advertises a tool to an agent, and then issues a request the backend will not honour. Anything
 * that merely loses information belongs in the note tier instead.
 *
 * Handled at their call sites (they need the operation key and the connector), listed here so
 * the argument lives beside the inventory rather than scattered.
 *
 *   - Operation / Path Item `servers` — the operation's backend is NOT the document's
 *     `servers[0]`, so the emitted connector points at the wrong host.
 *   - Parameter `content` — the parameter is not a simple scalar on the wire; reading it as one
 *     emits a `type: string` input for a value the backend expects to be a serialized document.
 */
export const SILENTLY_WRONG = ["servers", "content"] as const;

/** HTTP methods a path item may carry that `connector.schema.json` cannot express. Enumerated
 *  rather than inferred, so that an operation the adapter silently never offered becomes a
 *  report line: a `HEAD` or `TRACE` endpoint simply vanished before this existed. Each one gets
 *  its own named `unsupported-connector` note, so they are `refusedElsewhere` for the guard. */
export const UNSUPPORTED_METHODS = ["head", "options", "trace"] as const;

export const OPERATION_KEYS: KeyPolicy = {
  what: "operation",
  read: ["summary", "description", "operationId", "parameters", "requestBody", "responses", "security"],
  refusedElsewhere: ["servers"],
  inert: [
    // Categorisation for documentation browsers. Nothing downstream of the Draft Model has a
    // notion of a tag, and a capability's grouping is the human's call at the gate.
    "tags",
    // A link to prose. It cannot change a type, a name, a path or a required flag.
    "externalDocs",
  ],
};

export const PATH_ITEM_KEYS: KeyPolicy = {
  what: "path item",
  read: ["get", "put", "post", "patch", "delete", "parameters"],
  // `head`/`options`/`trace` each raise their own `unsupported-connector` note naming the exact
  // method and path — strictly more useful than "the path item declares `head`".
  refusedElsewhere: ["servers", ...UNSUPPORTED_METHODS],
  inert: [
    // Path-level prose. The capability's description comes from the OPERATION, deliberately:
    // one path with two methods is two capabilities with two different descriptions.
    "summary",
    "description",
  ],
};

export const PARAMETER_KEYS: KeyPolicy = {
  what: "parameter",
  read: ["$ref", "name", "in", "description", "required", "schema", "example"],
  refusedElsewhere: ["content"],
  inert: [],
};

export const REQUEST_BODY_KEYS: KeyPolicy = {
  what: "request body",
  read: ["$ref", "content", "required", "description"],
  refusedElsewhere: [],
  inert: [],
};

export const MEDIA_TYPE_KEYS: KeyPolicy = {
  what: "media type",
  read: ["schema"],
  refusedElsewhere: [],
  inert: [],
};

export const RESPONSE_KEYS: KeyPolicy = {
  what: "response",
  read: ["$ref", "content"],
  refusedElsewhere: [],
  inert: [
    // Required by the spec on every response, and it describes the RESPONSE rather than the
    // operation. The capability's description comes from the operation's own `summary`.
    "description",
  ],
};

export const ROOT_KEYS: KeyPolicy = {
  what: "document",
  read: ["openapi", "info", "servers", "paths", "components", "security"],
  refusedElsewhere: [],
  inert: [
    // Categorisation and prose, as on the operation.
    "tags",
    "externalDocs",
  ],
};

/**
 * Every key of `node` that is neither read nor argued inert, as notes.
 *
 * Returns notes rather than pushing them, so a caller can decide the scope and target — and so
 * this stays a pure function of the object, which is what makes the completeness test in
 * `document-coverage.test.ts` able to assert over it.
 */
export function unreadKeys(node: JsonObject | undefined, policy: KeyPolicy, scope: NoteScope, target: string | undefined): Note[] {
  if (!isObject(node)) return [];
  const notes: Note[] = [];
  for (const key of Object.keys(node)) {
    if (VENDOR_EXTENSION.test(key)) continue;
    if (policy.read.includes(key)) continue;
    if (policy.inert.includes(key)) continue;
    // The call site raises something more specific — a refusal, or a note naming the exact
    // method and path. A generic note beside it would report the same fact twice, in weaker
    // words, and pad the group the reader is meant to scan.
    if (policy.refusedElsewhere.includes(key)) continue;
    notes.push(
      note(
        "source-construct-not-read",
        scope,
        target,
        `the ${policy.what} declares \`${key}\`, which this adapter does not read — nothing it expresses reached the manifest`,
      ),
    );
  }
  return notes;
}
