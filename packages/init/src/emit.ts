// @archstone/init — pure emission: Draft Model + Decision Record → `Map<path, content>`.
//
// ADD-37 §6 step 2. NO fs, NO network, NO clock, NO randomness: this function returns bytes,
// and somebody else decides whether they ever touch a disk (that is `./loop`). Two consequences
// worth stating, because they are the reason the split exists at all:
//   - the same core serves a terminal today and a hosted "point us at your spec" flow later
//     (§9's forward constraint), with no second implementation;
//   - a golden-file test can pin every branch of the decision procedure without a temp dir.
//
// WHAT IS NEVER EMITTED (Challenge 2 — three well-meant defaults that are ship-stopping here):
//   1. `lifecycle:` — `experimental` is HIDDEN from `tools/list` (ADD-24's `lifecycleExposure`),
//      so a developer's first `archstone serve` after `init` would show an empty tool list.
//      Absent = `stable`, which is what a freshly-scaffolded capability actually is.
//   2. `policies:` — `authenticated` gates `callTool`, `executeCapability` AND `verifyTool`,
//      and neither `serve` (stdio) nor `verify` has a caller-injection surface. The manifest
//      would compile, pass `apply`, then fail every probe and every CLI invocation. Auth is
//      surfaced as a connector header with an `${ENV}` placeholder plus a report line.
//   3. `contract:` — the shipped schema requires `source: recorded` + `fingerprint` +
//      `probe.fixture`, and a fingerprint cannot exist without a real response. All-or-nothing;
//      a placeholder fingerprint would make `verify` green against a fiction.
//   4. `${caller.…}` — Amendment 1 §A-5's FOURTH non-emission, and the one a contributor is
//      most likely to add back, because the shipped `bank` manifest uses it. `invokeRest`
//      returns `missing caller credential(s)` when a `${caller.…}` placeholder has none, and
//      the CLI supplies no caller — so it fails every `archstone serve` (stdio) and every
//      `archstone verify`, the identical failure as `policies: [authenticated]` arrived at
//      from a different direction. `bank` is not a counter-example: it is an HTTP-transport
//      manifest, and `createHttpHandler` is the one surface that does supply a caller.
//      `init` emits `${ENV}` only.
// `failures:` is not emitted either: a 4xx's BUSINESS meaning is not derivable and the keys
// would be invented prose. Each of these has a test asserting the key is ABSENT, because a
// convention would not survive the next contributor.
//
// The ONE thing that may be emitted only when handed to this function as data: a `contract:`
// block. `emit` never invents one — it writes one iff the caller passes a `RecordedContract`,
// which only the loop's probe leg can produce, and only from a real response.

import {
  isKnown,
  valueOrUndefined,
  type DraftAuth,
  type DraftInputField,
  type DraftModel,
  type DraftOperation,
  type DraftNode,
  type DraftProperty,
  type DraftScalarNode,
  type Effect,
  type Fact,
} from "./model";
// Iterates `record.decisions` rather than `keptDecisions()`: a DECLINED candidate is not
// nothing, it is a report line, and dropping it here would make the report unable to say what
// the human turned down.
import { authEnvVar, baseUrlEnvVar, providerId, type CapabilityDecision, type DecisionRecord } from "./decisions";
import { classifyRequired, locusCandidates, locusLeaves, selectLocus, type LocusCandidate, type RequiredBasis } from "./d9";
import { note, skipsOperation, type Note, type ReasonCode } from "./reasons";
import {
  CAPABILITY_ID_RE,
  COMPANY_ID_RE,
  RESOURCE_NAME_RE,
  domainOfCapabilityId,
  envPlaceholder,
  outputFieldName,
  qualifyResourceName,
  singularize,
  toResourceLocalName,
} from "./names";
import { YamlWriter } from "./yaml";

/** `connector.schema.json`'s closed method set. Note what is NOT here: `HEAD`. An operation
 *  whose only method is `HEAD` cannot be expressed by a shipped connector, so it is skipped
 *  rather than rewritten into a `GET` that means something else. */
const CONNECTOR_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const PATH_PLACEHOLDER_RE = /\{([^}]+)\}/g;

export interface EmittedCapability {
  capabilityId: string;
  /** The `DraftOperation.key` this came from. */
  operation: string;
  effect: Effect;
  /** The resource this capability's response maps onto, when D-9 produced one. */
  resource?: string;
  /** Relative paths this capability contributed to `files`. */
  files: string[];
  notes: Note[];
}

export interface SkippedCandidate {
  operation: string;
  capabilityId?: string;
  code: ReasonCode;
  detail?: string;
}

export interface EmitResult {
  /** Relative path → file content. EMPTY when nothing may be written (D-7): the caller must
   *  treat an empty map as a refusal, never as "wrote zero files, carry on". */
  files: Map<string, string>;
  capabilities: EmittedCapability[];
  skipped: SkippedCandidate[];
  /** Every note raised, at every scope — the report's raw material. */
  notes: Note[];
}

/**
 * A contract the probe leg ACTUALLY RECORDED against a live backend (D-6), handed back to the
 * pure emitter as data.
 *
 * This is the only route by which a `contract:` block can reach an emitted file, and it is
 * deliberately an input rather than something `emit` can compute: the schema requires
 * `source: recorded` + `fingerprint` + `probe.fixture`, and a fingerprint cannot exist without
 * a real response. All-or-nothing, enforced by the shipped schema rather than by code
 * (Challenge 2 item 3) — a placeholder fingerprint would make `verify` green against a
 * fiction.
 */
export interface RecordedContract {
  fingerprint: string;
  /** The recorded response shape — `path -> type`, values never present (ADD-114). Optional:
   *  a recording made before ADD-114, or by a caller that does not supply one, still emits a
   *  valid `contract:`. */
  shape?: Record<string, string>;
  /** ISO timestamp, from the recorder's clock. `emit` has no clock of its own. */
  recordedAt: string;
  /** The golden fixture's exact JSON content. Written verbatim; never re-derived. */
  fixture: unknown;
}

/** A resource file, planned but not yet rendered — so a name conflict is detected before any
 *  bytes exist. */
interface PlannedResource {
  name: string;
  description?: string;
  fields: PlannedResourceField[];
  /** Where the name came from, for the file header. */
  origin: "declared-component" | "collection-property" | "human";
}

interface PlannedResourceField {
  name: string;
  type: string;
  values?: string[];
  required: boolean;
  basis: RequiredBasis;
  description?: string;
  /** JSONPath into one item, for the binding's `response.map`. */
  path: string;
  /** Rendered provenance, for the trailing comment on the map line. */
  provenance?: string;
}

interface PlannedInput {
  name: string;
  type: string;
  values?: string[];
  required: boolean;
  description?: string;
  wireName?: string;
}

interface PlannedCapability {
  decision: Extract<CapabilityDecision, { keep: true }>;
  operation: DraftOperation;
  domain: string;
  method: string;
  path: string;
  /** The auth that applies to THIS operation, already resolved against the manifest default. */
  auth?: DraftAuth;
  input: PlannedInput[];
  resource?: PlannedResource;
  /** Present iff a resource was planned. */
  response?: { collection?: string; outputField: string };
  /** JSONPaths a probe observed but that no resource was derived from — written into the
   *  binding as a TODO so the degraded path hands the human a starting point (product §5). */
  observedPaths?: string[];
  /** D-15: top-level scalars the chosen collection locus leaves unmapped. Rendered as a
   *  comment beside `response:`, so the cost is visible in the artifact and not only in a
   *  report the reviewer may never open. */
  droppedSiblings?: string[];
  notes: Note[];
}

/** A string worth writing, or `undefined`. Blank text from a source is not a description. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * The auth that applies to ONE operation (Amendment 1 §A-5 gap 1).
 *
 * `{kind: "none"}` on the operation is a positive statement that this endpoint is public and
 * must beat the manifest-level default — it is not the same as saying nothing. Getting this
 * backwards writes a credential header into every binding, and an `${ENV}` placeholder whose
 * variable is unset makes `invokeRest` fail with `missing env var(s)` BEFORE any network call,
 * so every public capability becomes un-invocable until the user sets a token they do not need.
 */
function authFor(draft: DraftModel, operation: DraftOperation): DraftAuth | undefined {
  if (operation.auth?.kind === "none") return undefined;
  if (operation.auth?.kind === "header") {
    const { kind: _kind, ...auth } = operation.auth;
    return auth;
  }
  return draft.auth;
}

/**
 * The wire value of an auth header: a literal prefix around an `${ENV}` placeholder.
 *
 * `Authorization: "Bearer ${ACME_API_TOKEN}"` — the shipped `bank` manifest's own form, which
 * `resolveEnv` handles as a substitution inside a literal string. A bare `${VAR}` for a
 * `type: http, scheme: bearer` scheme is silently wrong at the first real call, which is why
 * `DraftAuth` carries a prefix at all (§A-5 gap 2).
 */
function authHeaderValue(auth: DraftAuth, envVar: string): string {
  return `${auth.valuePrefix}${envPlaceholder(envVar)}`;
}

/** Render a value for a `# e.g. …` comment, bounded so one long string cannot swamp the line. */
function exampleText(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return "(unrenderable)"; // a cyclic structure; an observed body can contain one
  }
  if (text === undefined) return "(unrenderable)";
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

/**
 * The legibility comment for one mapped field (product §5), rendered FROM PROVENANCE (D-2) —
 * not a separate feature bolted on, just the Draft Model's derivations printed.
 *
 * This is the only mitigation that exists for R-9: a mapping that is structurally right and
 * semantically wrong (`price` mapped to `pricePerNight` when the backend returns a total)
 * compiles, verifies green, and misleads an agent in production. Automation cannot close that.
 * A two-column diff against a document the developer already knows can.
 */
function provenanceComment(node: DraftScalarNode): string | undefined {
  const parts: string[] = [];
  const located = [node.type, node.description, node.example].find((f) => isKnown(f) && f.source !== undefined) as
    | { derivation: "declared" | "observed"; source: string }
    | undefined;
  if (located) parts.push(`${located.derivation} ${located.source}`);
  if (isKnown(node.example)) parts.push(`e.g. ${exampleText(node.example.value)}`);
  // A bare derivation word with neither a source locator nor an example says nothing a reader
  // can act on, and a comment nobody can act on trains reviewers to skim the ones that matter.
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/** One line stating how a required/optional call was reached — the difference between a
 *  measurement and a claim, kept next to the claim. */
function basisComment(basis: RequiredBasis): string | undefined {
  switch (basis.kind) {
    case "declared":
      switch (basis.nullability.kind) {
        case "declared-nullable":
          return "declared required, but nullable — optional here (a null maps like a missing value)";
        case "unknown":
          // D-12's new case, and the one worth a line in the file: the source said "required"
          // but never established that the value cannot be null. `required: true` demands
          // positive evidence, so this is optional — and saying so is how a reviewer who knows
          // the backend can upgrade it by hand.
          return "declared required, but the source never established non-nullability — optional here; make it required if you know it is never null";
        case "declared-non-nullable":
        case "observed-non-null":
          return undefined;
      }
      return undefined;
    case "observational":
      return `classified from ${basis.items} observed item(s): present and non-null in ${basis.presentNonNull}`;
    case "unknown":
      return "no required-ness known from the source — optional, so a missing value degrades instead of violating";
  }
}

/** The semantic type to write, plus a note when nothing in the source implied one. */
function semanticTypeFor(
  type: Fact<string>,
  values: string[] | undefined,
  target: string,
  notes: Note[],
): { type: string; values?: string[] } {
  const declaredType = valueOrUndefined(type);
  if (declaredType === undefined) {
    notes.push(note("semantic-type-degraded", "field", target, "no source construct implied a richer type — this may be a `location`, a `money`, a `party`; only you know"));
    return { type: "string" };
  }
  if (declaredType === "enum") {
    if (!values || values.length === 0) {
      // `cdl.schema.json` requires `values` iff `type: enum`. An enum with no closed set is
      // not expressible, so it degrades to a string rather than emitting an invalid file.
      notes.push(note("semantic-type-degraded", "field", target, "declared as an enum with no closed value set — emitted as `string`"));
      return { type: "string" };
    }
    return { type: "enum", values };
  }
  return { type: declaredType };
}

function planInput(field: DraftInputField, capabilityId: string, notes: Note[]): PlannedInput {
  const target = `${capabilityId}#${field.name}`;
  const { type, values } = semanticTypeFor(field.type, field.values, target, notes);
  // A path parameter is required by construction: `interpolatePath` fails the call when one is
  // missing, so declaring it optional would only move the failure later.
  const required = field.in === "path" ? true : valueOrUndefined(field.required) ?? false;
  if (type === "identifier") {
    // R-4, the increment's headline known miss. No source construct says "this parameter is the
    // identity of a resource another operation returns", so the cross-capability link an agent
    // would benefit from degrades to a scalar. A tool limitation, never a language gap: `ref:`
    // exists, and only a human knows when it applies.
    notes.push(note("identity-ref-not-inferred", "field", target, "if this identifies a resource another capability returns, change `type: identifier` to `ref: <Resource>`"));
  }
  const description = nonEmpty(valueOrUndefined(field.description));
  return {
    name: field.name,
    type,
    ...(values ? { values } : {}),
    required,
    ...(description !== undefined ? { description } : {}),
    ...(field.wireName !== undefined && field.wireName !== field.name ? { wireName: field.wireName } : {}),
  };
}

function planResourceField(property: DraftProperty, path: string, capabilityId: string, notes: Note[]): PlannedResourceField {
  const node = property.node as DraftScalarNode; // callers pass scalar leaves only (D-9 step 2)
  const target = `${capabilityId}#${property.name}`;
  const { type, values } = semanticTypeFor(node.type, node.values, target, notes);
  const { required, basis } = classifyRequired(property);
  if (basis.kind === "observational") {
    notes.push(note("required-classification-observational", "field", target, `from ${basis.items} observed item(s)`));
  }
  const description = nonEmpty(valueOrUndefined(node.description));
  const provenance = provenanceComment(node);
  return {
    name: property.name,
    type,
    ...(values ? { values } : {}),
    required,
    basis,
    ...(description !== undefined ? { description } : {}),
    path,
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

/** D-9 steps 1–4 for one candidate. Returns `undefined` when the candidate is skipped
 *  entirely; a plan with no `resource` is the honest degraded path, not a failure. */
function planCapability(
  draft: DraftModel,
  operation: DraftOperation,
  decision: Extract<CapabilityDecision, { keep: true }>,
  skip: (code: ReasonCode, detail?: string) => void,
): PlannedCapability | undefined {
  // The adapter's own notes for this candidate are raised by the caller, so they survive even
  // when this function skips the candidate — "why was this operation skipped" is exactly the
  // question the adapter's note usually answers.
  const notes: Note[] = [];
  const capabilityId = decision.capabilityId;
  const domain = domainOfCapabilityId(capabilityId);

  const method = operation.method.toUpperCase();
  if (!CONNECTOR_METHODS.has(method) || operation.path === "") {
    skip("unsupported-connector", `method '${operation.method}' / path '${operation.path}'`);
    return undefined;
  }

  // The connector path's `{placeholders}` are interpolated BY EXACT NAME against the capability
  // input, so a placeholder with no matching input field is a binding that can never be invoked.
  // Refused here rather than emitted and discovered at the first call.
  const placeholders = [...operation.path.matchAll(PATH_PLACEHOLDER_RE)].map((m) => m[1]!);
  const inputNames = new Set(operation.input.map((f) => f.name));
  const unmatched = placeholders.filter((p) => !inputNames.has(p));
  if (unmatched.length > 0) {
    skip("unsupported-connector", `path placeholder(s) with no matching input field: ${unmatched.join(", ")}`);
    return undefined;
  }

  const input = operation.input.map((f) => planInput(f, capabilityId, notes));
  const auth = authFor(draft, operation);

  // D-14 — enumerate, then read the SELECTION. Never re-derive a preferred candidate here:
  // if the emitter could, the gate's question would be decorative and this would be branch
  // order with extra steps.
  const census = locusCandidates(operation.response);
  const selection = selectLocus(census, decision.responseLocus);

  const degraded = (detail?: string): PlannedCapability => {
    // The honest degraded path: a compiling manifest with an untyped capability, a connector,
    // and a TODO listing whatever JSONPaths were actually observed.
    notes.push(note("no-response-shape", "operation", capabilityId, detail));
    return {
      decision,
      operation,
      domain,
      method,
      path: operation.path,
      ...(auth ? { auth } : {}),
      input,
      notes,
      ...(census.observedPaths ? { observedPaths: census.observedPaths } : {}),
    };
  };

  for (const name of census.unaddressable) {
    notes.push(note("field-path-not-expressible", "operation", capabilityId, `an item list is under a property named '${name}', which no JSONPath can address`));
  }

  if (selection.kind === "ambiguous") {
    // A CHOICE EXISTS AND NOBODY MADE IT. `ambiguous-collection` keeps its job and widens its
    // meaning by exactly this case — R-6 makes the reason-code enum the scope boundary, so it
    // is worth saying that this decision moves it by zero.
    const offered = selection.candidates.map((c) => `${c.id} (${c.fields.join(", ")})`).join(" | ");
    skip(
      "ambiguous-collection",
      selection.supplied !== undefined
        ? `responseLocus '${selection.supplied}' matches no candidate. Candidates: ${offered}`
        : `the response could be mapped from ${selection.candidates.length} places and no responseLocus was supplied. Candidates: ${offered}`,
    );
    return undefined;
  }

  if (selection.kind === "none") {
    return degraded(census.observedPaths && census.observedPaths.length > 0 ? `observed paths: ${census.observedPaths.join(", ")}` : undefined);
  }

  const locus = selection.candidate;

  const { leaves, nested, unaddressable } = locusLeaves(locus.locus);
  for (const property of nested) {
    // D-16 — the text SPLITS BY NODE KIND, because the old single sentence was false for half
    // of them and the false half is the one a user would act on.
    //
    // A nested OBJECT's scalars really can be recovered by hand: a deeper JSONPath into the
    // same resource, and the shipped mapper evaluates arbitrary paths. A nested
    // ARRAY-OF-OBJECTS cannot — it needs a second resource and a second `response:` block, and
    // `binding.schema.json` gives `response` a single `$ref` (O-23). Telling someone to "map
    // it by hand" there sends them to do something the schema does not permit.
    //
    // This also hardens the depth-≤1 rule's rationale: promotion to a second resource is not
    // a deferred naming problem, it is structurally impossible today — there is nowhere to
    // land it.
    const isArray = property.node.kind === "array";
    notes.push(
      note(
        "nested-object-not-mapped",
        "field",
        `${capabilityId}#${property.name}`,
        isArray
          ? "a nested list cannot be recovered by hand today: it needs its own resource and a second `response:` block, and a binding carries only one"
          : "map it by hand if you need it — the shipped mapper evaluates arbitrary JSONPaths; only this generator is depth-bounded",
      ),
    );
  }
  for (const property of unaddressable) {
    notes.push(note("field-path-not-expressible", "field", `${capabilityId}#${property.name}`, "left out of the map — a path that resolves to nothing would be reported as drift that never happened"));
  }
  if (leaves.length === 0) {
    return degraded("the response shape has no addressable scalar leaf at depth 1");
  }

  // D-9 step 3 — name the resource. The human's answer wins when there is one: they were asked
  // precisely because nothing was derivable, and re-deriving over their answer would make the
  // question decorative. Otherwise: a source-declared component name, then a singularized
  // collection property, then refuse. Never invent silently.
  const declaredName = valueOrUndefined(locus.locus.name);
  const fromComponent = declaredName !== undefined ? toResourceLocalName(declaredName) : undefined;
  const fromProperty = locus.kind === "collection" && locus.property !== undefined ? toResourceLocalName(singularize(locus.property)) : undefined;
  const chosen = decision.resourceName ?? fromComponent ?? fromProperty;
  if (chosen === undefined || !RESOURCE_NAME_RE.test(chosen)) {
    skip("resource-name-not-derivable", chosen === undefined ? undefined : `'${chosen}' is not a valid resource name`);
    return undefined;
  }
  const resourceName = qualifyResourceName(chosen, domain);
  const origin: PlannedResource["origin"] = decision.resourceName !== undefined ? "human" : fromComponent !== undefined ? "declared-component" : "collection-property";

  const fields = leaves.map((leaf) => planResourceField(leaf.property, leaf.path, capabilityId, notes));

  // D-15 — SAY WHAT THE CHOSEN LOCUS DROPPED.
  //
  // Fires on a confirmed collection locus whose response root still has mappable scalars: the
  // human chose the list, and `quotedPrice`/`currency` (or `total`/`page`/`limit`) are gone
  // from the mapping regardless. That is exactly when a silent drop is most defensible and
  // therefore most worth writing down — a correct locus rule still owes the user a statement
  // of what it cost, and nothing before this inspected the siblings of a chosen locus at all.
  //
  // Adopted whichever way the locus decision had gone: annotating a guess does not stop it
  // being a guess, but a confirmed choice with an unstated cost is its own problem.
  const droppedSiblings = locus.kind === "collection" ? siblingScalarsOf(operation.response, locus) : [];
  if (droppedSiblings.length > 0) {
    notes.push(
      note(
        "nested-object-not-mapped",
        "operation",
        capabilityId,
        `this capability returns ${locus.collection}, so these top-level field(s) are NOT mapped: ${droppedSiblings.join(", ")}. If the capability is really about them, re-run and choose the 'root' locus.`,
      ),
    );
  }

  return {
    decision,
    operation,
    domain,
    method,
    path: operation.path,
    ...(auth ? { auth } : {}),
    input,
    notes,
    resource: {
      name: resourceName,
      ...(nonEmpty(valueOrUndefined(locus.locus.description)) !== undefined ? { description: nonEmpty(valueOrUndefined(locus.locus.description))! } : {}),
      fields,
      origin,
    },
    ...(droppedSiblings.length > 0 ? { droppedSiblings } : {}),
    response: {
      ...(locus.kind === "collection" ? { collection: locus.collection } : {}),
      outputField: outputFieldName(resourceName, locus.kind === "collection"),
    },
  };
}

/** The response root's addressable scalar leaves, which a collection locus does not map.
 *  Empty for a bare top-level array (there is no root object to drop anything from). */
function siblingScalarsOf(response: DraftNode, locus: LocusCandidate): string[] {
  if (response.kind !== "object" || locus.property === undefined) return [];
  return locusLeaves(response).leaves.map((leaf) => leaf.property.name);
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

function header(w: YamlWriter, draft: DraftModel, what: string): void {
  w.comment([
    what,
    "",
    `Generated by \`archstone init\` from ${draft.source.origin} (${draft.source.adapter} adapter).`,
    "Review before committing: every mapped line names where it came from, and the names and",
    "descriptions are exactly the parts no tool can infer for you.",
  ]);
  w.blank();
}

function writeFieldMap(w: YamlWriter, fields: Array<PlannedInput | PlannedResourceField>): void {
  for (const f of fields) {
    w.block(f.name, (fw) => {
      fw.entry("type", f.type);
      if (f.values) fw.flowList("values", f.values);
      // `required: true` is the CDL default and is left implicit, exactly as the hand-written
      // manifests do. `false` is always explicit — it is the load-bearing half (§1.2).
      if (!f.required) fw.entry("required", false);
      if (f.description !== undefined) fw.entry("description", f.description);
      if ("basis" in f) {
        const basis = basisComment(f.basis);
        if (basis) fw.comment(basis);
      }
    });
  }
}

function renderCapabilitiesFile(draft: DraftModel, record: DecisionRecord, plans: PlannedCapability[]): string {
  const w = new YamlWriter();
  header(w, draft, "capabilities.yaml — this company's contract with the AI world");
  w.block("company", (cw) => {
    cw.entry("id", record.company.id);
    const name = nonEmpty(record.company.name ?? valueOrUndefined(draft.company.name));
    if (name !== undefined) cw.entry("name", name);
    const description = nonEmpty(record.company.description ?? valueOrUndefined(draft.company.description));
    if (description !== undefined) cw.entry("description", description);
  });
  w.blank();
  w.block("capabilities", (cw) => {
    for (const p of plans) cw.item(p.decision.capabilityId);
  });
  w.blank();
  w.block("providers", (pw) => {
    pw.item(providerId(record));
  });
  return w.toString();
}

function renderCapabilityFile(draft: DraftModel, record: DecisionRecord, plan: PlannedCapability): string {
  const w = new YamlWriter();
  header(w, draft, `${plan.decision.capabilityId} — business shape only, no HTTP`);
  w.block("capability", (cw) => {
    cw.entry("id", plan.decision.capabilityId);
    // `cdl.schema.json` puts `minLength: 1` on a capability description, so an empty one from
    // the source is not merely ugly — it is a manifest the loader rejects, and under D-7 that
    // means the whole run writes nothing. Falls back to the connector, which is always present
    // and is at least true.
    cw.entry("description", nonEmpty(valueOrUndefined(plan.operation.description)) ?? `${plan.method} ${plan.path}`);
    // CONFIRMED by a human, never inferred: the Decision Record is the only source of this
    // value, which is why the emitter cannot see the adapter's hint at all (D-3).
    cw.entry("effect", plan.decision.effect, "confirmed at the gate — never inferred");

    if (plan.input.length > 0) {
      cw.blank();
      cw.block("input", (iw) => writeFieldMap(iw, plan.input));
    }

    if (plan.resource && plan.response) {
      cw.blank();
      cw.block("output", (ow) => {
        ow.block(plan.response!.outputField, (fw) => {
          if (plan.response!.collection !== undefined) fw.entry("collection", plan.resource!.name);
          else fw.entry("type", plan.resource!.name);
        });
      });
    } else {
      cw.blank();
      cw.comment([
        "No `output:` — the source described no usable response shape, so there is nothing to",
        "type honestly. The capability still compiles and is callable; add a resource and an",
        "output field by hand when you know the shape.",
      ]);
    }

    cw.blank();
    cw.entry("provider", providerId(record));
  });
  return w.toString();
}

function renderResourceFile(draft: DraftModel, resource: PlannedResource): string {
  const w = new YamlWriter();
  const origin =
    resource.origin === "human"
      ? "name supplied at the gate"
      : resource.origin === "declared-component"
        ? "name taken from the source's own component name"
        : "name derived from the response's collection property";
  header(w, draft, `${resource.name} — ${origin}`);
  w.block("resource", (rw) => {
    rw.entry("name", resource.name);
    if (resource.description !== undefined) rw.entry("description", resource.description);
    rw.block("fields", (fw) => writeFieldMap(fw, resource.fields));
  });
  return w.toString();
}

/** `fixtures/<capabilityId>.golden.json` — the path written into `contract.probe.fixture`,
 *  matching the shipped manifests' own layout. */
function fixturePath(capabilityId: string): string {
  return `fixtures/${capabilityId}.golden.json`;
}

function renderBindingFile(
  draft: DraftModel,
  record: DecisionRecord,
  plan: PlannedCapability,
  contract: RecordedContract | undefined,
): string {
  const w = new YamlWriter();
  header(w, draft, `${plan.decision.capabilityId} — implementation binding. NOT CDL`);
  w.block("binding", (bw) => {
    bw.entry("capabilityId", plan.decision.capabilityId);
    bw.block("connector", (cw) => {
      cw.entry("type", "rest");
      cw.block("rest", (rw) => {
        const observed = valueOrUndefined(draft.baseUrl);
        rw.entry("baseUrl", envPlaceholder(baseUrlEnvVar(record)), observed !== undefined ? `the source names ${observed}` : undefined);
        rw.entry("method", plan.method);
        rw.entry("path", plan.path);
        const remapped = plan.input.filter((f) => f.wireName !== undefined);
        if (remapped.length > 0) {
          rw.comment("the backend spells these differently on the wire; the CDL keeps the business name");
          rw.block("query", (qw) => {
            for (const f of remapped) qw.entry(f.name, f.wireName!);
          });
        }
        // Challenge 2 item 2: a declared security scheme becomes a header placeholder, never
        // `policies: [authenticated]`. Challenge 2 item 4 (Amendment 1 §A-5): the placeholder
        // is `${ENV}` and never `${caller.…}` — the CLI supplies no caller, so a caller
        // placeholder fails every `serve` and every `verify`. The value resolves from the
        // environment at invocation time; `init` never stores, logs, or writes a credential
        // into an emitted file.
        //
        // PER OPERATION, not per manifest: writing this header into a binding whose endpoint
        // is public makes that capability un-invocable until an unnecessary variable is set.
        if (plan.auth) {
          const envVar = authEnvVar(record);
          rw.comment(`auth (${plan.auth.scheme ?? "declared scheme"}): set ${envVar} in the environment that runs this manifest`);
          rw.block("headers", (hw) => {
            hw.entry(plan.auth!.headerName, authHeaderValue(plan.auth!, envVar));
          });
        }
      });
    });

    if (plan.resource && plan.response) {
      bw.blank();
      bw.comment([
        `Provider body → ${plan.resource.name}. The resource is the anchor; these JSONPaths are the`,
        "only thing that moves if the backend renames a field. A required field that is missing or",
        "null is a contract VIOLATION; an optional one DEGRADES.",
      ]);
      if (plan.droppedSiblings && plan.droppedSiblings.length > 0) {
        // D-15 in the ARTIFACT, not only in the report: the binding is what gets reviewed in a
        // pull request months later, and by then the report is gone.
        bw.comment([
          `This maps ${plan.response!.collection}, so these top-level field(s) are NOT mapped:`,
          `  ${plan.droppedSiblings.join(", ")}`,
          "If the capability is really about those, it needs a different response mapping —",
          "a binding carries exactly one, so it cannot return both.",
        ]);
      }
      bw.block("response", (rw) => {
        if (plan.response!.collection !== undefined) rw.entry("collection", plan.response!.collection);
        rw.entry("resource", plan.resource!.name);
        rw.block("map", (mw) => {
          for (const f of plan.resource!.fields) mw.entry(f.name, f.path, f.provenance);
        });
      });
    }

    if (!plan.resource) {
      // The degraded path's TODO (product §5): no `response:` block is invented, but whatever
      // a probe actually saw is handed over as a starting point. A hint for the human, not a
      // generator — and pointedly NOT a commented-out `response:` someone could uncomment
      // without reading.
      bw.blank();
      bw.comment([
        "No `response:` — no usable response shape was derived, so nothing here is typed and",
        "`archstone verify` has nothing to replay. To map it by hand, add a `response:` block",
        "naming a resource and its fields.",
      ]);
      if (plan.observedPaths && plan.observedPaths.length > 0) {
        bw.comment(["", "JSONPaths actually observed in the response, as a starting point:"]);
        for (const path of plan.observedPaths) bw.comment(`  ${path}`);
      }
    }

    if (contract) {
      // A REAL recording, made by `recordContract` over the same `invokeRest` call
      // `verifyTool` replays (D-6 / R-1) — so the artifact written here is by construction the
      // artifact `archstone verify` will trust. Reached only when the human consented to a
      // probe, the capability's confirmed effect was `read`, the method rule allowed it, and
      // the recorded response then passed a real `runVerify` over the written files.
      bw.blank();
      bw.comment([
        "What we recorded the live backend returning, at the time shown. `archstone verify`",
        "replays this fixture's `request` and compares the response shape — that is how you",
        "find out the backend changed before an agent does.",
      ]);
      bw.block("contract", (cw) => {
        cw.entry("source", "recorded");
        cw.entry("fingerprint", contract.fingerprint);
        if (contract.shape) {
          const shape = contract.shape;
          // Sorted, so re-running `init` over an unchanged backend produces byte-identical
          // bytes — the property this whole writer exists to preserve. Keys are quoted by
          // `yamlKey` (every path starts with `$` and most contain `[`/`]`), so no special
          // handling is needed here.
          cw.block("shape", (sw) => {
            for (const path of Object.keys(shape).sort()) sw.entry(path, shape[path]);
          });
        }
        cw.entry("verifiedAt", contract.recordedAt);
        cw.block("probe", (pw) => {
          pw.entry("fixture", fixturePath(plan.decision.capabilityId));
        });
      });
    } else {
      // No `contract:` — see this file's header. It is all-or-nothing and requires a recorded
      // response; `archstone verify` reports an un-probed binding as unverified, never as green.
    }
  });
  return w.toString();
}

/**
 * Draft Model + Decision Record → the exact bytes of a manifest.
 *
 * The `effect` of every emitted capability comes from the Decision Record and from nowhere
 * else — this function never reads `DraftOperation.effectHint`, and could not silently start
 * to, because the hint's type is not assignable to anything it writes.
 */
export function emit(
  draft: DraftModel,
  record: DecisionRecord,
  contracts?: ReadonlyMap<string, RecordedContract>,
): EmitResult {
  const notes: Note[] = [...draft.notes];
  const skipped: SkippedCandidate[] = [];
  const files = new Map<string, string>();

  const refuse = (code: ReasonCode, detail?: string): EmitResult => {
    notes.push(note(code, "manifest", undefined, detail));
    return { files: new Map(), capabilities: [], skipped, notes };
  };

  if (!COMPANY_ID_RE.test(record.company.id)) {
    return refuse("company-id-not-derivable", `'${record.company.id}' does not match ^[a-z][a-z0-9-]*$`);
  }
  if (!COMPANY_ID_RE.test(providerId(record))) {
    return refuse("company-id-not-derivable", `provider '${providerId(record)}' does not match ^[a-z][a-z0-9-]*$`);
  }

  const byKey = new Map(draft.operations.map((op) => [op.key, op]));
  const plans: PlannedCapability[] = [];
  const claimedIds = new Set<string>();
  const resources = new Map<string, { resource: PlannedResource; owner: string }>();

  for (const decision of record.decisions) {
    if (!decision.keep) {
      skipped.push({ operation: decision.operation, code: "declined", ...(decision.note !== undefined ? { detail: decision.note } : {}) });
      notes.push(note("declined", "operation", decision.operation, decision.note));
      continue;
    }

    const skipCandidate = (code: ReasonCode, detail?: string): void => {
      skipped.push({ operation: decision.operation, capabilityId: decision.capabilityId, code, ...(detail !== undefined ? { detail } : {}) });
      notes.push(note(code, "operation", decision.capabilityId, detail));
    };

    const operation = byKey.get(decision.operation);
    if (!operation) {
      // LIST THE REAL KEYS. The bare "no such candidate" message is misleading in the common
      // case: the source has NOT changed — the author wrote the key the way the document
      // spells it (`/catalog/frames`) while the candidate key carries the server's base path
      // (`GET /api/v1/catalog/frames`). The draft has the answers in hand, so withholding
      // them turns a five-second correction into a guessing game.
      const known = [...byKey.keys()];
      const shown = known.slice(0, 12).map((k) => `'${k}'`).join(", ");
      skipCandidate(
        "unknown-candidate",
        `no candidate keyed '${decision.operation}'. The draft's candidate keys are: ${shown}${known.length > 12 ? `, … (${known.length} total)` : ""}`,
      );
      continue;
    }
    // Raised before the plan, so an adapter's own notes for this candidate survive even when
    // the candidate is then skipped — that note is usually the reason it was skipped.
    notes.push(...operation.notes);

    // AND THEN ACTUALLY HONOUR THEM. `skipsOperation: true` is not an annotation, it is a
    // promise about the file system — "the candidate produces NO files at all" — and until
    // now the emitter recorded the adapter's refusals and emitted the capability regardless.
    //
    // That is worse than it sounds. An operation the adapter refused for an unresolvable
    // `$ref` or a `oneOf` it could not reduce arrives here with an `unknown` response, so it
    // was emitted down the degraded path: a compiling, serving, agent-visible capability with
    // no output — built from a document the adapter had already said it could not read. For
    // `unsupported-parameter-location` it was worse still: the header parameter is dropped,
    // so the emitted connector calls the backend without a value it requires.
    //
    // Found by asserting the promise rather than the note (the two are not the same claim).
    const refusal = operation.notes.find((n) => skipsOperation(n.code));
    if (refusal) {
      skipCandidate(refusal.code, refusal.detail);
      continue;
    }
    if (!CAPABILITY_ID_RE.test(decision.capabilityId)) {
      skipCandidate("capability-id-invalid", `'${decision.capabilityId}'`);
      continue;
    }
    if (claimedIds.has(decision.capabilityId)) {
      skipCandidate("capability-id-conflict");
      continue;
    }

    const plan = planCapability(draft, operation, decision, skipCandidate);
    if (!plan) continue;

    if (plan.resource) {
      const existing = resources.get(plan.resource.name);
      if (existing && !sameFields(existing.resource, plan.resource)) {
        skipCandidate("resource-name-conflict", `'${plan.resource.name}' is already emitted by ${existing.owner} with a different field set`);
        continue;
      }
      if (!existing) resources.set(plan.resource.name, { resource: plan.resource, owner: decision.capabilityId });
    }

    claimedIds.add(decision.capabilityId);
    plans.push(plan);
    notes.push(...plan.notes);
  }

  if (plans.length === 0) {
    // §4 caveat 1: `capabilities.schema.json` sets `minItems: 1` on both `capabilities` and
    // `providers`, so an empty confirmed set cannot produce a shape-valid manifest at all.
    // Refusing here means the invariant is discovered by design rather than by accident.
    return refuse("empty-confirmed-set");
  }

  files.set("capabilities.yaml", renderCapabilitiesFile(draft, record, plans));
  for (const { resource } of resources.values()) {
    files.set(`${resource.name}.resource.yaml`, renderResourceFile(draft, resource));
  }

  const capabilities: EmittedCapability[] = plans.map((plan) => {
    const capabilityFile = `${plan.decision.capabilityId}.capability.yaml`;
    const bindingFile = `bindings/${plan.decision.capabilityId}.binding.yaml`;
    const contract = contracts?.get(plan.decision.capabilityId);
    files.set(capabilityFile, renderCapabilityFile(draft, record, plan));
    files.set(bindingFile, renderBindingFile(draft, record, plan, contract));
    const own = [capabilityFile, bindingFile];
    if (contract) {
      // Written verbatim, with a trailing newline, so a re-run of `init` over the same
      // recording produces a byte-identical file and `git diff` stays honest.
      const path = fixturePath(plan.decision.capabilityId);
      files.set(path, `${JSON.stringify(contract.fixture, null, 2)}\n`);
      own.push(path);
    }
    if (plan.resource) own.push(`${plan.resource.name}.resource.yaml`);
    return {
      capabilityId: plan.decision.capabilityId,
      operation: plan.operation.key,
      effect: plan.decision.effect,
      ...(plan.resource ? { resource: plan.resource.name } : {}),
      files: own,
      notes: plan.notes,
    };
  });

  // Say so once per UNPROBED capability, so an un-probed binding reads as a known state
  // rather than as an omission — and so that a probed one is visibly not in this list.
  for (const c of capabilities) {
    if (!contracts?.has(c.capabilityId)) notes.push(note("contract-not-recorded", "operation", c.capabilityId));
  }
  // Per-operation, because auth is per-operation: a manifest-level note would claim every
  // capability needs a credential when the source says five of them are public.
  for (const plan of plans) {
    if (!plan.auth) continue;
    notes.push(
      note(
        "security-scheme-not-a-policy",
        "operation",
        plan.decision.capabilityId,
        `${plan.auth.scheme ?? "declared scheme"} → header '${plan.auth.headerName}'; set ${authEnvVar(record)} in the environment. No \`policies:\` and no \`\${caller.…}\` was emitted.`,
      ),
    );
  }

  return { files, capabilities, skipped, notes };
}

/**
 * Do two plans for the same resource name describe the same fields? Compared structurally
 * (name, type, required, and the closed VALUE SET), not by rendered bytes, so a differing
 * comment is not a conflict.
 *
 * `values` belongs in the key and was missing from it. Two capabilities deriving the same
 * resource name with a `status: enum` of `[active, discontinued]` and `[active, discontinued,
 * banned]` compared equal, no `resource-name-conflict` was raised, and the resource kept the
 * FIRST one's narrower set — while the second capability's binding still mapped onto it. The
 * MCP `outputSchema` then advertises an enum the second backend can legitimately violate, and
 * the reference client validates `structuredContent` against `outputSchema` unconditionally.
 * That is precisely the "the second would silently overwrite the first's fields" failure this
 * code exists to prevent, missed by its own equality key.
 */
function sameFields(a: PlannedResource, b: PlannedResource): boolean {
  if (a.fields.length !== b.fields.length) return false;
  // Order-normalized: `values` order is a rendering detail, not a contract.
  const key = (f: PlannedResourceField): string => `${f.name}:${f.type}:${f.required}:${[...(f.values ?? [])].sort().join("|")}`;
  const left = a.fields.map(key).sort();
  const right = b.fields.map(key).sort();
  return left.every((v, i) => v === right[i]);
}
