// The OpenAPI adapter — `paths` → candidate operations.
//
// One candidate per path × method, 1:1, never merged: `init` proposes and the human prunes.
// Merging endpoints into composite capabilities is inference nobody can check, and product §3
// keeps it out.
//
// Everything this file cannot carry across comes back as a `Note` with a code from the closed
// list. That is the scope boundary made visible (R-6), and it is also why nothing here throws.

import {
  absent,
  declared,
  type DraftInputField,
  type DraftNode,
  type DraftOperation,
  type DraftOperationAuth,
  type EffectHint,
  type Fact,
} from "../../model";
import { note, type Note } from "../../reasons";
import {
  MEDIA_TYPE_KEYS,
  OPERATION_KEYS,
  PARAMETER_KEYS,
  PATH_ITEM_KEYS,
  REQUEST_BODY_KEYS,
  RESPONSE_KEYS,
  ROOT_KEYS,
  UNSUPPORTED_METHODS,
  unreadKeys,
} from "./coverage";
import { DocumentSet, isObject, resolveRef, type JsonObject, type JsonValue } from "./document";
import { lowerSchema, lowerTopLevel, type LowerContext } from "./schema";
import type { SemanticType } from "@archstone/compiler";

/** Methods `connector.schema.json` can express. `HEAD` is deliberately absent from the shipped
 *  connector, so a `HEAD`-only operation is skipped rather than rewritten into a `GET` that
 *  means something else. */
const CONNECTOR_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const JSON_MEDIA_RE = /^application\/(?:[\w.+-]+\+)?json$/i;

export interface OperationsResult {
  operations: DraftOperation[];
  /** Manifest-scope notes (a security scheme nobody could reduce, a missing `paths`). */
  notes: Note[];
  /** The manifest-level default auth, when the document declares a global `security`. */
  auth?: { headerName: string; valuePrefix: string; scheme?: string };
  baseUrl: Fact<string>;
  /** Server path prefix (`/api/v1`), prepended to every operation path so the connector's
   *  `path` and the `baseUrl` env placeholder split the same way the hand-written manifests
   *  split them. */
  pathPrefix: string;
}

/**
 * Split `servers[0].url` into an origin and a path prefix.
 *
 * `https://api.example.com/api/v1` → baseUrl `https://api.example.com`, prefix `/api/v1`.
 * Mechanical, not a choice: `baseUrl` becomes an `${ENV}` placeholder a deployer points at
 * staging or production, and a prefix baked into that variable would make the two environments
 * disagree about where the version segment lives.
 */
export function splitServerUrl(url: string): { origin: string; prefix: string } | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)(\/.*)?$/.exec(url.trim());
  if (!match) return undefined;
  const prefix = (match[2] ?? "").replace(/\/+$/, "");
  return { origin: match[1]!, prefix };
}

function firstServerUrl(root: JsonObject): string | undefined {
  const servers = root["servers"];
  if (!Array.isArray(servers)) return undefined;
  for (const server of servers) {
    if (isObject(server) && typeof server["url"] === "string") return server["url"];
  }
  return undefined;
}

/** `listFrameProfiles` → `list-frame-profiles`; `getFrameProfile` → `get-frame-profile`. */
export function slugifyAction(raw: string): string | undefined {
  const kebab = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(kebab) ? kebab : undefined;
}

/**
 * A one-line description for the capability.
 *
 * `summary` first, and that ordering is load-bearing rather than stylistic: a real spec's
 * `description` is a page of Markdown (tables, formulae, worked examples), and pasting it into
 * a CDL `description:` produces a tool description an agent has to read in full on every
 * `tools/list`. `cdl.schema.json` puts `minLength: 1` on it, so an empty one is a manifest the
 * loader rejects — hence the fall-through to the first non-empty line and then to nothing.
 */
export function oneLineDescription(operation: JsonObject): string | undefined {
  const summary = operation["summary"];
  if (typeof summary === "string" && summary.trim() !== "") return summary.trim();
  const description = operation["description"];
  if (typeof description === "string") return firstParagraph(description);
  return undefined;
}

/**
 * The first PARAGRAPH of a Markdown block, with its line breaks collapsed.
 *
 * Not the first line, which is the obvious implementation and is wrong: real spec prose is
 * hard-wrapped, so "first line" cuts a sentence in half. On the oracle that produced
 * `description: "Passepartout pe latură, în cm. Absent ⇒ 0. Ignorat (forțat la 0) pentru"` —
 * a description that stops mid-clause, in a field whose entire job is to tell an agent what
 * the parameter means. A truncated description is worse than a missing one, because it reads
 * like a complete thought.
 *
 * A paragraph break is the author's own boundary, so taking one is not a guess about where
 * the useful part ends.
 */
function firstParagraph(text: string): string | undefined {
  const paragraph = text.split(/\n\s*\n/)[0] ?? "";
  const collapsed = paragraph
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ")
    .trim();
  return collapsed === "" ? undefined : collapsed;
}

/** Product D-4's `*Id` rule. Scoped to INPUTS by the ADD's §1 table, so it is deliberately not
 *  applied to response fields. */
const ID_NAME_RE = /(?:^id$|Id$|_id$)/;

/**
 * THE input classifier — one, for every input, wherever it travels.
 *
 * Parameters and request-body properties are the same thing at the CDL layer: a named business
 * value the agent supplies. Classifying them differently is how the two drift, so this takes an
 * ALREADY-LOWERED node and both callers go through it. That matters most for a body, where the
 * `allOf` merge (D-10) has to have completed before anything reads a property's type — lowering
 * each property's raw schema a second time here would quietly bypass the merge.
 */
function inputSemanticType(name: string, lowered: DraftNode | undefined, where: string, what: string): { type: Fact<SemanticType>; values?: string[] } {
  if (ID_NAME_RE.test(name)) return { type: declared<SemanticType>("identifier", where) };
  if (lowered === undefined) return { type: absent<SemanticType>(`the ${what} declares no schema`) };
  if (lowered.kind !== "scalar") return { type: absent<SemanticType>(`the ${what}'s schema is not a scalar`) };
  return { type: lowered.type, ...(lowered.values ? { values: lowered.values } : {}) };
}

/**
 * D-12 for an input: `required: true` demands POSITIVE evidence of non-nullability.
 *
 * The same sentence as the response side, applied where it is equally load-bearing and was
 * equally unwritten. A source that declares a field required and simultaneously admits `null`
 * for it has not established that the agent must supply a value, and CDL has no way to say
 * "required, but null is a value" — so the honest lowering is optional.
 *
 * Shared by parameters and body properties for the reason above: two rules is how they diverge.
 */
function classifyInputRequired(declaredRequired: boolean, nullable: Fact<boolean>, source: string): Fact<boolean> {
  if (!declaredRequired) return declared(false, source);
  return declared(nullable.derivation !== "absent" && nullable.value === false, source);
}

/** A parameter's own schema, lowered once. `undefined` when it declares none (the `content:`
 *  form, which v1 does not read). */
function parameterSchemaNode(schema: JsonObject | undefined, ctx: LowerContext, where: string): DraftNode | undefined {
  if (!schema) return undefined;
  return lowerSchema(schema, ctx.docs.keys()[0] ?? "", where, ctx);
}

interface ParameterResult {
  fields: DraftInputField[];
  /** Set when a parameter lives somewhere v1 does not model. */
  refusal?: Note;
}

function collectParameters(
  raw: JsonValue | undefined,
  docKey: string,
  ctx: LowerContext,
  seenNames: Set<string>,
): ParameterResult {
  const fields: DraftInputField[] = [];
  if (!Array.isArray(raw)) return { fields };

  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry)) continue;
    let parameter = entry;
    let source = `${ctx.target}/parameters/${index}`;
    const ref = entry["$ref"];
    if (typeof ref === "string") {
      const resolved = resolveRef(ctx.docs, docKey, ref);
      if (typeof resolved === "string" || !isObject(resolved.node)) {
        return { fields, refusal: note("unsupported-ref", "operation", ctx.target, `parameter ${ref} (${typeof resolved === "string" ? resolved : "not an object"})`) };
      }
      parameter = resolved.node;
      source = ref;
    }

    const name = parameter["name"];
    const location = parameter["in"];
    if (typeof name !== "string" || typeof location !== "string") continue;
    if (location !== "path" && location !== "query") {
      // `header`/`cookie` parameters have no CDL construct: a business capability's input is
      // business data, and a transport header is not. Refused per operation rather than
      // dropped, because dropping one silently emits a binding that cannot work.
      return { fields, refusal: note("unsupported-parameter-location", "operation", ctx.target, `parameter '${name}' is in: ${location}`) };
    }
    // A duplicate name across the path-level and operation-level parameter lists is the same
    // parameter; the operation-level one is processed first and wins.
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    // A parameter using `content:` instead of `schema:` is not a simple scalar on the wire, and
    // reading it as one emits a `type: string` input for a value the backend expects to be a
    // serialized document. Refused rather than degraded — `SILENTLY_WRONG`'s second member.
    if (parameter["content"] !== undefined) {
      return {
        fields,
        refusal: note("unsupported-parameter-location", "operation", ctx.target, `parameter '${name}' is declared with \`content:\` rather than \`schema:\`, so it is not a plain scalar on the wire`),
      };
    }
    ctx.notes.push(...unreadKeys(parameter, PARAMETER_KEYS, "operation", ctx.target));

    const schema = isObject(parameter["schema"]) ? parameter["schema"] : undefined;
    const node = parameterSchemaNode(schema, ctx, source);
    // Same rule as a body property, for the same reason: a CDL input field is a scalar, and an
    // array- or object-valued parameter degrading to `type: string` advertises a parameter the
    // backend cannot accept. Previously it degraded silently; the coverage audit is what found
    // it, since `style`/`explode` are read by nothing and an array parameter is what needs them.
    if (node !== undefined && node.kind !== "scalar" && !ctx.fatal) {
      return {
        fields,
        refusal: note("unsupported-parameter-location", "operation", ctx.target, `parameter '${name}' has a ${node.kind} schema; CDL input fields are scalars, and \`style\`/\`explode\` are not modeled in v1`),
      };
    }
    const { type, values } = inputSemanticType(name, node, source, "parameter");

    // §1.3 precedence, kept and reported: an `example` is someone's ILLUSTRATION; a `default`
    // means "the same as omitting the parameter". The human confirming a live call deserves to
    // see which one they are looking at, so the locator says.
    const example: Fact<unknown> =
      parameter["example"] !== undefined
        ? declared(parameter["example"] as unknown, `${source}/example`)
        : schema?.["default"] !== undefined
          ? declared(schema["default"] as unknown, `${source}/schema/default`)
          : absent<unknown>();

    const description = parameter["description"];
    fields.push({
      name,
      in: location,
      type,
      ...(values ? { values } : {}),
      // A path parameter is required by construction (`interpolatePath` fails the call without
      // it), so no evidence of nullability could make it optional. A query parameter goes
      // through D-12 like every other input.
      required:
        location === "path"
          ? declared(true, source)
          : classifyInputRequired(parameter["required"] === true, node?.kind === "scalar" ? node.nullable : absent<boolean>("the parameter's schema is not a scalar"), source),
      description: typeof description === "string" ? declared(oneLine(description), source) : absent<string>(),
      example,
    });
  }
  return { fields };
}

function oneLine(text: string): string {
  return firstParagraph(text) ?? text.trim();
}

/** The 2xx response schema, or a reason there is none to map. */
function responseNode(operation: JsonObject, docKey: string, ctx: LowerContext): { node: DraftNode; notes: Note[] } {
  const notes: Note[] = [];
  const responses = operation["responses"];
  if (!isObject(responses)) return { node: { kind: "unknown" }, notes };

  const codes = Object.keys(responses);
  if (codes.some((c) => /^[45]/.test(c))) {
    // A 4xx's BUSINESS meaning is not derivable and `failures:` keys would be invented prose.
    // Reported as an unmapped affordance rather than guessed at.
    notes.push(note("failures-not-emitted", "operation", ctx.target, `error responses declared: ${codes.filter((c) => /^[45]/.test(c)).join(", ")}`));
  }

  // `200` first, then any other 2xx in document order. `default` is deliberately NOT used: it
  // is the catch-all, and in every real document it describes the error case.
  const successCode = codes.includes("200") ? "200" : codes.find((c) => /^2/.test(c));
  if (successCode === undefined) return { node: { kind: "unknown" }, notes };

  let response = responses[successCode];
  let source = `${ctx.target}/responses/${successCode}`;
  if (isObject(response) && typeof response["$ref"] === "string") {
    const resolved = resolveRef(ctx.docs, docKey, response["$ref"]);
    if (typeof resolved === "string") {
      notes.push(note("unsupported-ref", "operation", ctx.target, `response ${successCode}: ${resolved}`));
      return { node: { kind: "unknown" }, notes };
    }
    source = response["$ref"];
    response = resolved.node;
    docKey = resolved.docKey;
  }
  if (!isObject(response)) return { node: { kind: "unknown" }, notes };
  notes.push(...unreadKeys(response, RESPONSE_KEYS, "operation", ctx.target));

  const content = response["content"];
  if (!isObject(content)) return { node: { kind: "unknown" }, notes };
  const mediaTypes = Object.keys(content);
  const jsonType = mediaTypes.find((m) => JSON_MEDIA_RE.test(m));
  if (jsonType === undefined) {
    notes.push(note("unsupported-media-type", "operation", ctx.target, `2xx content is ${mediaTypes.join(", ")}`));
    return { node: { kind: "unknown" }, notes };
  }
  const media = content[jsonType];
  if (!isObject(media) || !isObject(media["schema"])) return { node: { kind: "unknown" }, notes };
  notes.push(...unreadKeys(media, MEDIA_TYPE_KEYS, "operation", ctx.target));

  return { node: lowerTopLevel(media["schema"], docKey, `${source}/content/${jsonType}/schema`, ctx), notes };
}

/**
 * A declared security scheme reduced to a connector header — the ONLY thing v1 does with auth.
 *
 * `undefined` means "cannot be reduced at all", and Amendment 1 §A-5 gap 3 is emphatic about
 * the disposition: skip the operation. Emitting a connector that silently drops the credential
 * produces a capability that compiles, serves, advertises itself to an agent, and then 401s on
 * every single call — worse than not emitting it.
 */
/** Every refusal on the input side speaks with one code; the detail says which case it is.
 *  `unsupported-parameter-location`'s summary was widened to stay true at all of them. */
function inputRefusal(key: string, detail: string): Note {
  return note("unsupported-parameter-location", "operation", key, detail);
}

/**
 * An operation's `requestBody` → capability input fields.
 *
 * THE DEFECT THIS CLOSES. `requestBody` was read by nothing here, so an operation whose input
 * lives in a JSON body emitted a capability with no `input:` at all — silently. It compiled,
 * passed `apply`, and wrote files; an agent got a search tool with no parameters, POSTed an
 * empty body, and got a 400.
 *
 * SCOPED THE WAY THE REST OF THIS ADAPTER IS SCOPED. `application/json` only, matching §4's
 * existing exclusion of XML and multipart on the response side — the same rule read from the
 * other direction. Composition inside the body goes through the SAME D-10 `allOf` machinery as
 * everything else, property types through the SAME D-4 classifier, required through the SAME
 * D-12 rule. A second implementation of any of those is how the two sides drift.
 *
 * HOW IT REACHES THE WIRE, which is what bounds the whole feature: `invokeRest` serializes the
 * capability input as the JSON body for any method that is not `GET`/`HEAD`, keyed by the CDL
 * field name. There is no `rest.body` per-field mapping and no body counterpart to `rest.query`,
 * so a body property is expressible EXACTLY when its own name can be the CDL field name and
 * nothing else already claims that name. Everything this function refuses, it refuses because
 * the connector could not have carried it.
 */
function collectRequestBody(
  operation: JsonObject,
  key: string,
  method: string,
  ctx: LowerContext,
  seenNames: Set<string>,
): ParameterResult {
  const fields: DraftInputField[] = [];
  const raw = operation["requestBody"];
  if (raw === undefined) return { fields };

  // A `GET` may legally DECLARE a body; nothing can send one. `invokeRest` gives a body only to
  // methods that are not `GET`/`HEAD`, so every field here would vanish between the manifest and
  // the wire — the exact silence this whole change exists to end.
  if (method === "get" || method === "head") {
    return { fields, refusal: inputRefusal(key, `a \`requestBody\` on ${method.toUpperCase()}, which the REST connector never sends — its fields could not reach the backend`) };
  }

  let body = raw;
  let docKey = "";
  let source = `${ctx.target}/requestBody`;
  if (isObject(body) && typeof body["$ref"] === "string") {
    const resolved = resolveRef(ctx.docs, docKey, body["$ref"]);
    if (typeof resolved === "string") {
      return { fields, refusal: note("unsupported-ref", "operation", key, `requestBody ${body["$ref"]}: ${resolved}`) };
    }
    source = body["$ref"];
    body = resolved.node;
    docKey = resolved.docKey;
  }
  if (!isObject(body)) return { fields, refusal: inputRefusal(key, "the `requestBody` is not an object") };
  ctx.notes.push(...unreadKeys(body, REQUEST_BODY_KEYS, "operation", key));

  const content = body["content"];
  if (!isObject(content)) return { fields, refusal: inputRefusal(key, "the `requestBody` declares no `content`") };
  const mediaTypes = Object.keys(content);
  const jsonType = mediaTypes.find((m) => JSON_MEDIA_RE.test(m));
  if (jsonType === undefined) {
    // The same line §4 already draws for responses. A multipart or XML body is not a shape this
    // version can turn into named business inputs, and guessing at one would be worse.
    return { fields, refusal: note("unsupported-media-type", "operation", key, `requestBody content is ${mediaTypes.join(", ")}`) };
  }
  const media = content[jsonType];
  if (!isObject(media) || !isObject(media["schema"])) {
    return { fields, refusal: inputRefusal(key, `the \`requestBody\`'s ${jsonType} media type declares no schema`) };
  }
  ctx.notes.push(...unreadKeys(media, MEDIA_TYPE_KEYS, "operation", key));

  const node = lowerTopLevel(media["schema"], docKey, `${source}/content/${jsonType}/schema`, ctx);
  // An unresolvable or genuinely ambiguous body schema is a refusal, not a guess — and it is
  // already one: `ctx.fatal` carries the `unsupported-ref` / `unsupported-composition` the
  // lowering raised, and the caller turns it into the operation's skip. Adding a second refusal
  // here would only bury the real cause under a vaguer one.
  if (ctx.fatal) return { fields };
  if (node.kind !== "object") {
    return { fields, refusal: inputRefusal(key, `the \`requestBody\` schema is a ${node.kind}, which has no named fields that could become capability inputs`) };
  }
  if (node.properties.length === 0) {
    return { fields, refusal: inputRefusal(key, "the `requestBody` schema declares no properties, so there is nothing to name as an input") };
  }

  // A body that is not itself required makes every one of its properties optional, whatever the
  // schema's own `required[]` says: the caller may legally send no body at all.
  const bodyRequired = body["required"] === true;

  for (const property of node.properties) {
    // One CDL input field cannot be two different wire values. `rest.query` can separate a
    // remapped query name from its CDL name; there is no body counterpart, so a body property
    // that collides with a path or query parameter is genuinely inexpressible — and picking a
    // winner silently is how one of the two values disappears.
    if (seenNames.has(property.name)) {
      return { fields, refusal: inputRefusal(key, `the \`requestBody\` declares '${property.name}', which is already a path or query parameter — one CDL input field cannot carry both`) };
    }

    // CDL input fields are SCALARS. A nested object or array has no semantic type, and letting
    // it degrade to `string` would advertise a string parameter for a field the backend needs
    // an object in — a capability that compiles, serves, and fails every call.
    if (property.node.kind !== "scalar") {
      return { fields, refusal: inputRefusal(key, `the \`requestBody\` property '${property.name}' is a ${property.node.kind}; CDL input fields are scalars, and there is no connector construct that could place a nested value`) };
    }

    seenNames.add(property.name);
    const propertySource = `${source}/content/${jsonType}/schema/properties/${property.name}`;
    const { type, values } = inputSemanticType(property.name, property.node, propertySource, "request body property");
    const declaredRequired = bodyRequired && property.declaredRequired.derivation !== "absent" && property.declaredRequired.value;

    fields.push({
      name: property.name,
      in: "body",
      type,
      ...(values ? { values } : {}),
      required: classifyInputRequired(declaredRequired, property.node.nullable, propertySource),
      description: property.node.description,
      // D-13 unchanged: a spec example SEEDS the gate's pre-fill and the legibility comment. It
      // is never read as probe input — only `DecisionRecord.sampleInput` reaches the wire.
      example: property.node.example,
    });
  }

  return { fields };
}

/**
 * A query parameter on a method that carries a body.
 *
 * Found by the coverage audit rather than by the bug report, and it predates this change:
 * `invokeRest` appends a query string ONLY when there is no body, so for `POST`/`PUT`/`PATCH`/
 * `DELETE` an `in: query` field is folded into the JSON body instead. The emitted binding
 * therefore sends the value at the wrong place on the wire, silently — the reported defect's
 * exact class, arrived at from the other side.
 *
 * Making it WORK needs a connector construct that does not exist (a way to say "this field goes
 * in the query even on a method with a body"), which is a schema decision and not this
 * increment's to take. Making it SAFE needs only this. So: refused, and the fork is reported.
 */
function queryOnBodyMethodRefusal(fields: DraftInputField[], key: string, method: string): Note | undefined {
  if (method === "get" || method === "head") return undefined;
  const query = fields.filter((f) => f.in === "query").map((f) => f.name);
  if (query.length === 0) return undefined;
  return inputRefusal(
    key,
    `query parameter(s) ${query.join(", ")} on ${method.toUpperCase()}: the REST connector appends a query string only when there is no body, so these would be sent inside the JSON body instead of on the URL`,
  );
}

export function reduceSecurityScheme(scheme: JsonObject): { headerName: string; valuePrefix: string; scheme?: string } | undefined {
  const type = scheme["type"];
  if (type === "http") {
    const httpScheme = String(scheme["scheme"] ?? "").toLowerCase();
    // `Bearer <token>` is the wire value, so the prefix is not optional dressing: a bare
    // `${VAR}` here is a header that is silently wrong at the first real call.
    if (httpScheme === "bearer") return { headerName: "Authorization", valuePrefix: "Bearer ", scheme: "http/bearer" };
    // `http/basic` is REFUSED, and it is worth saying why rather than leaving it to fall
    // through with the others. It looks reducible — `Authorization: Basic ${ENV}` — and an
    // earlier revision of this function emitted exactly that. It is wrong: RFC 7617 makes the
    // value `base64(username:password)`, not a token, so the emitted header is only correct if
    // the user happens to put a pre-encoded credential pair in the variable. `init` would be
    // instructing them to "set ACME_API_TOKEN" for something that is not a token, and the
    // failure is a 401 they have to reverse-engineer. Amendment 1 §A-5 gap 3 named only
    // `http/bearer` and `apiKey/header` as reducible; this stays outside that line.
    return undefined;
  }
  if (type === "apiKey" && scheme["in"] === "header" && typeof scheme["name"] === "string") {
    return { headerName: scheme["name"], valuePrefix: "", scheme: "apiKey/header" };
  }
  // `apiKey` in a query string or cookie, `oauth2`, `openIdConnect`: none reduces to a static
  // header, and none has a credential this tool could place.
  return undefined;
}

/** Resolve a `security: [{name: []}]` requirement list to the first scheme that reduces. */
function authFromSecurity(
  security: JsonValue | undefined,
  root: JsonObject,
  docKey: string,
  ctx: LowerContext,
): { auth: DraftOperationAuth } | { unsupported: string } | undefined {
  if (!Array.isArray(security)) return undefined;
  if (security.length === 0) return { auth: { kind: "none" } };

  const names: string[] = [];
  for (const requirement of security) {
    if (isObject(requirement)) names.push(...Object.keys(requirement));
  }
  if (names.length === 0) return { auth: { kind: "none" } };

  for (const name of names) {
    const schemes = isObject(root["components"]) && isObject(root["components"]["securitySchemes"]) ? root["components"]["securitySchemes"] : undefined;
    let scheme = schemes?.[name];
    if (isObject(scheme) && typeof scheme["$ref"] === "string") {
      const resolved = resolveRef(ctx.docs, docKey, scheme["$ref"]);
      scheme = typeof resolved === "string" ? undefined : resolved.node;
    }
    if (!isObject(scheme)) continue;
    const reduced = reduceSecurityScheme(scheme);
    if (reduced) return { auth: { kind: "header", ...reduced } };
  }
  return { unsupported: names.join(", ") };
}

/** `GET`/`HEAD` are the only methods whose semantics imply anything, and even then only as a
 *  hint the human still has to confirm — a `POST /search` is `read` (Axiom A-1). */
function effectHintFor(method: string): EffectHint | undefined {
  if (method !== "get" && method !== "head") return undefined;
  return { value: "read", derivation: "heuristic", rationale: `${method.toUpperCase()} usually reads; confirm it does not also change something` };
}

export function collectOperations(docs: DocumentSet, notes: Note[]): OperationsResult {
  const root = docs.primary;
  if (!isObject(root)) {
    return { operations: [], notes, baseUrl: absent<string>("the document could not be parsed"), pathPrefix: "" };
  }

  const serverUrl = firstServerUrl(root);
  const split = serverUrl === undefined ? undefined : splitServerUrl(serverUrl);
  const baseUrl: Fact<string> =
    split === undefined
      ? absent<string>(serverUrl === undefined ? "the document declares no `servers`" : `\`servers[0].url\` is not an absolute URL: ${serverUrl}`)
      : declared(split.origin, "#/servers/0/url");
  const pathPrefix = split?.prefix ?? "";

  const globalSecurity = authFromSecurity(root["security"], root, "", { docs, target: "#/security", notes: [] });
  const modelAuth =
    globalSecurity !== undefined && "auth" in globalSecurity && globalSecurity.auth.kind === "header"
      ? (({ kind: _kind, ...rest }) => rest)(globalSecurity.auth)
      : undefined;

  const operations: DraftOperation[] = [];
  const paths = root["paths"];
  if (!isObject(paths)) {
    notes.push(note("unsupported-operation-shape", "manifest", undefined, "the document declares no `paths`"));
    return { operations, notes, ...(modelAuth ? { auth: modelAuth } : {}), baseUrl, pathPrefix };
  }

  notes.push(...unreadKeys(root, ROOT_KEYS, "manifest", undefined));

  for (const [rawPath, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) continue;
    const pathItem = pathItemValue;
    notes.push(...unreadKeys(pathItem, PATH_ITEM_KEYS, "manifest", rawPath));

    // Methods no shipped connector can express. They used to produce no candidate and no word
    // about it, so a `HEAD` or `TRACE` endpoint simply vanished between the document and the
    // report — the same silence as `requestBody`, one object higher.
    for (const unsupported of UNSUPPORTED_METHODS) {
      if (isObject(pathItem[unsupported])) {
        notes.push(note("unsupported-connector", "manifest", `${unsupported.toUpperCase()} ${pathPrefix}${rawPath}`, `\`connector.schema.json\` has no ${unsupported.toUpperCase()} method, so this operation was not offered as a candidate`));
      }
    }

    for (const method of CONNECTOR_METHODS) {
      const operationValue = pathItem[method];
      if (!isObject(operationValue)) continue;
      const operation = operationValue;
      const path = `${pathPrefix}${rawPath}`;
      const key = `${method.toUpperCase()} ${path}`;
      const ctx: LowerContext = { docs, target: key, notes: [] };
      ctx.notes.push(...unreadKeys(operation, OPERATION_KEYS, "operation", key));

      // `servers` on an operation or a path item says this operation's backend is NOT the
      // document's `servers[0]` — so the connector this adapter would write points at the wrong
      // host. `SILENTLY_WRONG`'s first member: a capability that compiles, serves, and calls
      // somewhere the human never named.
      const overriddenServer = operation["servers"] !== undefined || pathItem["servers"] !== undefined;

      const seenNames = new Set<string>();
      const own = collectParameters(operation["parameters"], "", ctx, seenNames);
      const shared = collectParameters(pathItem["parameters"], "", ctx, seenNames);
      // Parameters first, so `seenNames` is populated before the body can collide with one.
      const body = collectRequestBody(operation, key, method, ctx, seenNames);
      const parameterFields = [...own.fields, ...shared.fields];
      const serverRefusal = overriddenServer
        ? note("unsupported-connector", "operation", key, "the operation or its path item declares its own `servers`, so its backend is not the document's `servers[0]` and no correct connector baseUrl could be written")
        : undefined;
      const parameterRefusal =
        serverRefusal ?? own.refusal ?? shared.refusal ?? body.refusal ?? queryOnBodyMethodRefusal(parameterFields, key, method);

      const security = authFromSecurity(operation["security"], root, "", ctx);
      const securityRefusal =
        security !== undefined && "unsupported" in security
          ? note("unsupported-security-scheme", "operation", key, `no declared scheme reduces to a header: ${security.unsupported}`)
          : globalSecurity !== undefined && "unsupported" in globalSecurity && security === undefined
            ? note("unsupported-security-scheme", "operation", key, `the document's global security has no reducible scheme: ${globalSecurity.unsupported}`)
            : undefined;

      const response = responseNode(operation, "", ctx);
      const operationNotes = [...ctx.notes, ...response.notes];

      const refusal = parameterRefusal ?? securityRefusal;
      if (refusal) operationNotes.push(refusal);
      if (ctx.fatal) operationNotes.push(note(ctx.fatal.code, "operation", key, ctx.fatal.detail));

      const operationId = operation["operationId"];
      const action = typeof operationId === "string" ? slugifyAction(operationId) : slugifyAction(`${method}-${rawPath}`);
      const description = oneLineDescription(operation);
      const hint = effectHintFor(method);

      const candidate: DraftOperation = {
        key,
        method: method.toUpperCase(),
        path,
        suggestedAction: action === undefined ? absent<string>() : declared(action, typeof operationId === "string" ? `${key}/operationId` : key),
        description: description === undefined ? absent<string>() : declared(description, key),
        ...(hint ? { effectHint: hint } : {}),
        input: [...parameterFields, ...body.fields],
        // An operation the adapter had to refuse carries an `unknown` response, so the emitter
        // cannot accidentally map half of it: the refusal note is the whole story, and the
        // human sees it at the gate before anything is written.
        response: refusal || ctx.fatal ? { kind: "unknown" } : response.node,
        ...(security !== undefined && "auth" in security ? { auth: security.auth } : {}),
        notes: operationNotes,
      };
      operations.push(candidate);
    }
  }

  return { operations, notes, ...(modelAuth ? { auth: modelAuth } : {}), baseUrl, pathPrefix };
}
