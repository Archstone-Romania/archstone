// @archstone/init — the Draft Model (ADD-37 D-1 / D-2).
//
// `init`'s PRIVATE intermediate. It is not the IR and not the Semantic Model: it never leaves
// this package, nothing downstream consumes it, and no emitter has ever heard of it. What it
// is for: letting the input format be an ADAPTER rather than the architecture. A
// `SourceAdapter` turns an opaque input handle into one of these; everything after that —
// resource emission, YAML emission, the loop, the report, the diff harness — is written
// against this file and knows nothing about OpenAPI, or about recorded responses, or about
// whatever the third adapter reads.
//
// THE LOAD-BEARING PROPERTY (D-2): every fact carries its DERIVATION. A field's type, its
// required-ness, its example value, its description — each says whether an adapter read it
// from a declaration, saw it in a real response, or simply does not know. Lowering rules and
// the report both branch on derivation, so an adapter that can only supply `observed` facts
// degrades honestly instead of silently. It also pays for the legibility requirement for
// free: the source-field comment and the observed example on each `response.map` line are
// RENDERED FROM PROVENANCE, not bolted on as a separate feature.
//
// No LLM is involved in producing or consuming this model, on any path, in any adapter.

import type { SemanticType } from "@archstone/compiler";
import type { Note } from "./reasons";

/**
 * How an adapter came by a fact.
 *
 * `declared` — a source document said so (a spec's `required[]`, a `format: date`).
 * `observed` — an adapter saw it in a real response body.
 * `absent`   — nobody knows. NOT a default, NOT a guess: the absence is the fact.
 *
 * A GUESS IS NOT A DERIVATION AND NEVER WILL BE. That is why `heuristic` is not a member here
 * but a separate literal on `EffectHint` below (D-3): if "the method was GET, so probably
 * read" could wear the same type as "the spec declared it", one `Fact<Effect>` would be enough
 * to write an `effect:` into a manifest without a human ever confirming it.
 */
export type Derivation = "declared" | "observed" | "absent";

/**
 * A value plus its derivation — or the honest absence of one.
 *
 * Modelled as a union rather than as `{value?, derivation}` on purpose: `value` does not exist
 * on the `absent` arm, so TypeScript will not let a caller read a value it does not have. The
 * "degrades honestly instead of silently" property is therefore checked by the compiler, not by
 * review.
 */
export type Fact<T> =
  | { derivation: "declared" | "observed"; value: T; source?: string }
  | { derivation: "absent"; reason?: string };

/** A fact a source document stated. `source` locates it (e.g. `#/components/schemas/Frame.name`). */
export function declared<T>(value: T, source?: string): Fact<T> {
  return source === undefined ? { derivation: "declared", value } : { derivation: "declared", value, source };
}

/** A fact an adapter saw in a real response. `source` locates it (e.g. `$.items[0].name`). */
export function observed<T>(value: T, source?: string): Fact<T> {
  return source === undefined ? { derivation: "observed", value } : { derivation: "observed", value, source };
}

/** No fact. `reason` is for the report, never for a default. */
export function absent<T = never>(reason?: string): Fact<T> {
  return reason === undefined ? { derivation: "absent" } : { derivation: "absent", reason };
}

/** Narrowing helper: does this fact carry a value? */
export function isKnown<T>(fact: Fact<T>): fact is { derivation: "declared" | "observed"; value: T; source?: string } {
  return fact.derivation !== "absent";
}

/** The fact's value, or the caller's explicit fallback. The fallback is always visible at the
 *  call site — there is deliberately no `Fact` API that quietly invents one. */
export function valueOr<T>(fact: Fact<T>, fallback: T): T {
  return isKnown(fact) ? fact.value : fallback;
}

/** The fact's value when present, else `undefined`. */
export function valueOrUndefined<T>(fact: Fact<T>): T | undefined {
  return isKnown(fact) ? fact.value : undefined;
}

export type Effect = "read" | "write" | "irreversible";

/**
 * An adapter's GUESS at a capability's effect (D-3).
 *
 * Carried separately from every `Fact` in this file and stamped with its own derivation
 * literal, because a guess must never be mistakable for a derivation. The pure emitter takes
 * the Decision Record — never this — so "no `effect` without human confirmation" is a
 * type-level property of the emission signature rather than a runtime check someone can
 * forget. This exists only so the terminal gate can PRE-FILL an answer the human still has to
 * give (and per product §11.1, only for `GET`).
 */
export interface EffectHint {
  value: Effect;
  derivation: "heuristic";
  /** Why the adapter guessed this, in the human's words at the gate. */
  rationale: string;
}

/** How many recorded items carried a property, out of how many were seen (§1.2). */
export interface ObservedPresence {
  /** Items examined. `0` means nothing was observed — never treat it as "always absent". */
  items: number;
  /** Items where the property was present AND non-null. */
  presentNonNull: number;
}

/**
 * The shape of a response (or of one property of it), as neutrally as an adapter can state it.
 *
 * Deliberately STRUCTURAL and un-decided: D-9's decision procedure (which node is the item
 * locus, what becomes a resource, what is skipped) runs in the pure emitter, over this. An
 * adapter that pre-decided would make the decision procedure per-adapter, which is the one
 * thing D-1 exists to prevent.
 */
export type DraftNode = DraftScalarNode | DraftObjectNode | DraftArrayNode | DraftUnknownNode;

export interface DraftScalarNode {
  kind: "scalar";
  /** The semantic type, when mechanically derivable. `absent` ⇒ the emitter falls back to
   *  `string` and records `semantic-type-degraded`. */
  type: Fact<SemanticType>;
  /** Closed value set — meaningful only when `type` is `enum`. */
  values?: string[];
  /** Declared or observed nullability. Load-bearing: the shipped mapper treats `null`
   *  identically to `undefined`, so a REQUIRED field mapping to `null` is a VIOLATION (§1.2). */
  nullable: Fact<boolean>;
  description: Fact<string>;
  /** A real value, for the legibility comment on the emitted `response.map` line. */
  example: Fact<unknown>;
}

export interface DraftObjectNode {
  kind: "object";
  /** A name the SOURCE gave this shape (`#/components/schemas/FrameProfile` → `FrameProfile`).
   *  The emitter prefers it when naming a resource; it never invents one (D-9 step 3). */
  name: Fact<string>;
  description: Fact<string>;
  properties: DraftProperty[];
}

export interface DraftArrayNode {
  kind: "array";
  items: DraftNode;
}

/** A shape no adapter could describe. `observedPaths` is the TODO list product §5 asks for:
 *  whatever JSONPaths a probe actually saw, handed to the human as a hint — not a generator. */
export interface DraftUnknownNode {
  kind: "unknown";
  observedPaths?: string[];
}

export interface DraftProperty {
  /** The property name exactly as the payload/spec spells it. Never re-cased: the mapping's
   *  JSONPath and the resource's field name both derive from this one string. */
  name: string;
  /**
   * Did the SOURCE DECLARE this property required?
   *
   * An `observed` derivation never belongs here — presence in a payload is evidence, not a
   * declaration. Evidence goes in `presence`, and §1.2's rule combines the two.
   */
  declaredRequired: Fact<boolean>;
  /** Per-item presence evidence, when an adapter saw real items. */
  presence?: ObservedPresence;
  node: DraftNode;
}

/** Where an input value travels on the wire. */
export type InputLocation = "path" | "query" | "body";

export interface DraftInputField {
  /**
   * The CDL input field name. For a `path` field this MUST equal the `{placeholder}` in the
   * connector path — the REST provider interpolates by exact name.
   */
  name: string;
  in: InputLocation;
  /** The wire name, when the backend spells it differently (`widthCm` → `width_cm`). Emitted
   *  into `rest.query`, so the CDL stays business-shaped and the wire stays whatever it is. */
  wireName?: string;
  type: Fact<SemanticType>;
  values?: string[];
  required: Fact<boolean>;
  description: Fact<string>;
  /** A sample value — the only source of probe input a document can offer (§1.3). */
  example: Fact<unknown>;
}

/**
 * One candidate operation: something the source can do, which a human may or may not confirm
 * is a capability. `init` proposes 1:1 and asks the human to prune; it never MERGES endpoints
 * into composite capabilities, which is inference nobody can check (product §3).
 */
export interface DraftOperation {
  /** Stable candidate key, used to join a Decision Record entry to this operation.
   *  `"<METHOD> <path>"` by convention — the same pair the diff harness joins tools by. */
  key: string;
  method: string;
  path: string;
  /** A slug for the action half of a capability id (`list-frame-profiles`). The DOMAIN half is
   *  not derivable from any source construct and always comes from the human. */
  suggestedAction: Fact<string>;
  description: Fact<string>;
  /** A guess, never a fact (D-3). The emitter does not read this. */
  effectHint?: EffectHint;
  input: DraftInputField[];
  response: DraftNode;
  /** This operation's auth, when the source states one per operation. Absent ⇒ inherit
   *  `DraftModel.auth`. See `DraftOperationAuth` for why this is not manifest-scoped. */
  auth?: DraftOperationAuth;
  /** What this candidate's adapter could not carry across. */
  notes: Note[];
}

/**
 * A declared auth scheme, reduced to the only thing v1 does with it: a connector header
 * carrying an `${ENV}` placeholder (Challenge 2 item 2). Never `policies: [authenticated]`,
 * and never `${caller.…}` — Amendment 1 §A-5's fourth non-emission, which fails every
 * `archstone serve` (stdio) and every `archstone verify` for the identical reason
 * `policies: [authenticated]` does: the CLI supplies no caller.
 *
 * NOTE what is NOT here: the environment variable name. It is not derivable from any source
 * construct (Amendment 1 §A-5 gap 4), so it lives in the Decision Record beside
 * `baseUrlEnvVar`, confirmed at the gate. An adapter describes the SHAPE of the credential;
 * the human names the variable that carries it.
 */
export interface DraftAuth {
  /** Header the credential travels in (`Authorization`, `X-Api-Key`). */
  headerName: string;
  /**
   * Literal text the wire value carries BEFORE the placeholder.
   *
   * `"Bearer "` for `type: http, scheme: bearer`; `""` for `apiKey, in: header`. Amendment 1
   * §A-5 gap 2: writing a bare `${VAR}` for a bearer scheme produces a header that is
   * silently wrong at the first real call. `resolveEnv` substitutes inside a literal string,
   * so `Authorization: "Bearer ${X}"` — the shipped `bank` manifest's own form — works
   * unchanged.
   */
  valuePrefix: string;
  /** The scheme as the source named it, for the report only. */
  scheme?: string;
}

/**
 * One operation's auth, which is NOT a manifest-level fact (Amendment 1 §A-5 gap 1).
 *
 * Real documents declare `security: []` per operation and a scheme on only some of them. A
 * manifest-level header written into every binding makes every PUBLIC capability un-invocable
 * until the user sets a token they do not need: an `${ENV}` placeholder whose variable is
 * unset makes `invokeRest` return `missing env var(s)` BEFORE any network call.
 *
 * `undefined` on an operation means "inherit `DraftModel.auth`"; `{kind: "none"}` means the
 * source positively declared this operation public, which is a different fact and must
 * override the default.
 */
export type DraftOperationAuth = { kind: "none" } | ({ kind: "header" } & DraftAuth);

export interface DraftModel {
  version: "0";
  source: {
    /** The `SourceAdapter.id` that produced this model. */
    adapter: string;
    /** Where the input came from, for the report and the generated file headers. */
    origin: string;
  };
  company: {
    id: Fact<string>;
    name: Fact<string>;
    description: Fact<string>;
  };
  /** The backend's base URL as the source states it. The emitter writes an `${ENV}`
   *  placeholder and keeps this in a comment — the shipped manifests' own convention. */
  baseUrl: Fact<string>;
  /** The manifest-level DEFAULT auth, overridable per operation. */
  auth?: DraftAuth;
  operations: DraftOperation[];
  /** Manifest-level things the adapter could not carry across. */
  notes: Note[];
}

/**
 * What a host has ALREADY fetched on an adapter's behalf.
 *
 * Adapters are pure (see `SourceAdapter`): reading a file and opening a socket are the host's
 * jobs — the loop's and the CLI's — so that `adapt()` stays a total function of its input and
 * so that a hosted flow (§9's forward constraint) can call the identical code with bytes it
 * obtained however it likes.
 */
export interface SourceInput {
  /** Where this came from (a path, a URL, a description). Reported, never dereferenced here. */
  origin: string;
  /** Already-read document text, for adapters that parse a document. */
  document?: string;
  /**
   * D-11 — ADDITIONAL documents the host fetched because `references()` asked for them,
   * keyed by the exact reference string the adapter returned.
   *
   * Real specs are multi-file: ArtVinci's catalog `$ref`s a shared component library for its
   * pagination schema, and an adapter that cannot see the target must fail closed and skip
   * the operation — which is half the oracle. `adapt` stays synchronous and pure because it
   * still never reads anything itself; the host does the reading and calls it again.
   */
  documents?: Record<string, string>;
  /** Already-recorded observations, for adapters that derive from real traffic. */
  observations?: SourceObservation[];
}

/** One real request/response pair a host recorded on the adapter's behalf. */
export interface SourceObservation {
  method: string;
  path: string;
  /** The capability-level input used, when one was. */
  request?: Record<string, unknown>;
  status?: number;
  /** The parsed response body. */
  response: unknown;
}

/**
 * The input boundary (D-1).
 *
 * ADDING THE *SECOND* ADAPTER MUST TOUCH NO FILE OUTSIDE `src/adapters/`.
 *
 * That is a restatement, and Amendment 1 §A-2 is where it was earned: the acceptance test
 * used to say "adding an adapter", and the very first adapter broke it, because a single-
 * `document` input cannot carry a multi-file spec. The dent is the right kind — the first
 * implementation of an interface is exactly what discovers that the interface was
 * underspecified — but claiming the property for the first adapter was claiming to have got
 * an interface right before writing a single implementation of it.
 *
 * The interface is otherwise deliberately tiny:
 *   - `adapt` is SYNCHRONOUS and PURE — no fs, no network, no clock, no randomness. Same input,
 *     same Draft Model, forever. A tool whose pitch is determinism cannot have an inference
 *     stage that answers differently on Tuesday.
 *   - It never throws for unsupported input: everything it cannot handle comes back as a
 *     `Note` with a code from the closed reason list (R-6), so an unhandled construct is
 *     reportable data rather than a stack trace.
 */
export interface SourceAdapter {
  /** Stable identifier, recorded in `DraftModel.source.adapter` (e.g. `"openapi"`). */
  readonly id: string;
  /** One line, for `--help` and the report. */
  readonly summary: string;
  adapt(input: SourceInput): DraftModel;
  /**
   * D-11 — the document-relative targets this adapter still needs, given what it has.
   *
   * The HOST fetches; the adapter stays pure. The host resolves each target within the input
   * document's own directory subtree (no URL, no network, no `..` escape), adds the bytes to
   * `SourceInput.documents` under the same key, and calls again — until this returns nothing
   * or a bounded iteration cap is hit. Anything still unresolved after closure is the
   * adapter's own problem to report as a note, not the host's to guess at.
   *
   * Why a method rather than "let the CLI scan for `$ref`": scanning IS OpenAPI knowledge,
   * and OpenAPI knowledge lives only under `adapters/`. One method keeps it there.
   *
   * Optional: an adapter that reads one self-contained input never implements it.
   */
  references?(input: SourceInput): string[];
}
