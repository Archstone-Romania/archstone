// @archstone/provider-rest — REST adapter (#6)
//
// The first adapter under providers/. Maps a capability's input → an HTTP request
// (from its IR connector) and the HTTP response → a result. REST only. baseUrl,
// headers and auth resolve from env via ${VAR} placeholders, and (ADD-32) from a
// per-invocation caller credential via ${caller.NAME} placeholders. HTTP lives HERE
// and nowhere else — the compiler/IR/emitter never touch it.

import type { IRTool } from "@archstone/compiler";
// #44: TYPE-ONLY. `invokeRest` never reads the audit sink — see `InvokeOptions.auditSink`
// below. The type is owned by the layer that acts on it (beside the policy evaluator and the
// record builder), and this package merely carries the field so a deployer keeps ONE options
// bag. Same shape of dependency as @archstone/agent type-importing `CallerContext` from here.
import type { AuditSink, RateLimitCounter } from "@archstone/emitter-support";

export interface InvokeResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

export type FetchLike = typeof globalThis.fetch;

/**
 * A fact about ONE invocation — never about the compiled artifact (ADD-32 D-1). The IR is
 * reused across many invocations by many different end users; a caller credential lives only
 * in invoke-context types (here, and threaded through `agent`'s `ExecuteOptions` / `runtime`'s
 * `serveStdio`/`createHttpHandler`), never in `IRTool`/`IR`.
 */
export interface CallerContext {
  /** The end user's bearer token, supplied by a host that has already authenticated them
   *  (Archstone does not host an OIDC broker). Undefined means "no caller supplied" — the
   *  fail-closed gate below distinguishes that from an explicit `""`, which is treated as
   *  present (ADD-32 §3/R-6, mirrors this file's existing env-var precedent). */
  accessToken?: string;
  /** Reserved for `tenant-scoped` policy enforcement — NOT enforced by ADD-32 (D-4/R-5), and
   *  deliberately still not enforced by #43 (BR-39: tenant scoping is a third axis, distinct
   *  from credential-presence and identity, and is refused rather than absorbed as a side
   *  effect of a policy increment). The shape carries this now so a future increment doesn't
   *  need a second breaking change to `CallerContext`; nothing reads this field yet. */
  tenantId?: string;
  /**
   * WHO this invocation acts on behalf of — the caller's identity, as opposed to `accessToken`,
   * which is a credential to act WITH (ADD-42 D-2/D-3; two fields, never merged: #44's audit
   * record must always carry the principal and must never carry the credential).
   *
   * **Asserted by the host, never verified by Archstone.** Archstone does not parse, decode,
   * split, normalize, or validate this value at any entry point, ever (ADD-42 D-1) — it is an
   * opaque, deployer-chosen string, matched byte-for-byte against a policy's `allow`/`deny`
   * entries and nothing more. Its trustworthiness is exactly the trustworthiness of the host's
   * own authentication and no more: if the host reads a JWT's `sub` without verifying the
   * signature against the issuer's JWKS, Archstone will faithfully authorize on an
   * attacker-controlled string and #44 will faithfully record it. Archstone cannot detect this.
   *
   * Absent means ANONYMOUS, not denied (ADD-42 D-4) — there is no sentinel value. An absent
   * principal simply satisfies no `allow` entry, so a capability that must not be invoked
   * anonymously says so by declaring one. Supplying a principal does NOT satisfy
   * `policies: [authenticated]`, which still requires `accessToken` (D-7).
   *
   * Usable in `${caller.principal}` interpolation with zero new mechanism, via the existing
   * `resolveCaller()` pass below (ADD-42 D-10) — the common enterprise shape where a backend is
   * reached with a service account that accepts a trusted identity header.
   */
  principal?: string;
}

export interface InvokeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** ADD-32: the end user this specific invocation acts on behalf of. `invokeRest` uses it for
   *  `${caller.NAME}` placeholder substitution ONLY — it makes no authorization decision from
   *  it, so an absent caller changes nothing here beyond leaving those placeholders unresolved
   *  (which fails closed on its own, as a missing value rather than a refusal).
   *
   *  Whether a caller is REQUIRED — `policies: [authenticated]` — is decided upstream at the
   *  one evaluation point (#43), not in this file. Do not look for that gate here. */
  caller?: CallerContext;
  /**
   * Security-hardening follow-up to ADD-32: a **deployer-level policy**, static for the whole
   * process/deployment — set once at construction time, like `bearerToken` elsewhere in this
   * codebase (`runtime/src/http.ts`'s `CreateHttpHandlerOptions.bearerToken`), NOT per-request/
   * per-invocation like `caller` above. Only relevant when a binding's `rest.baseUrl` contains a
   * `${caller.NAME}` placeholder (per-tenant routing) — see the guard in `invokeRest` for why
   * that specific case, unlike headers/query/body, needs an allowlist at all.
   *
   * Each entry is either an exact hostname (`"api.example.com"`) or a `"*."`-prefixed wildcard
   * matching any subdomain (`"*.core.example.com"` matches `tenant-a.core.example.com` but NOT
   * `core.example.com` itself — list that separately if it must also be allowed).
   *
   * Undefined/empty is the secure default: a baseUrl whose *original template* referenced
   * `${caller.…}` fails closed unless the resolved host explicitly matches an entry here.
   */
  allowedHosts?: string[];
  /**
   * Issue #39 / ADD-31: a fire-and-forget observation hook for the RAW, unmapped backend
   * response of a completed HTTP round-trip (any status, 2xx or non-2xx). It exists so a
   * developer whose bound capability's own backend happens to bill per call/token (most
   * concretely, a capability whose connector calls a paid LLM completions API) can inspect
   * whatever usage/cost/audit fields that backend's response happens to contain — data a
   * `response:` mapping would otherwise silently discard before either caller (`callTool`,
   * `executeCapability`) ever sees it.
   *
   * Fires exactly once, synchronously, immediately after the response body is parsed —
   * BEFORE any response-mapping/OK-DEGRADED-VIOLATION classification runs in the caller
   * (BR-1/BR-3), including on a contract VIOLATION, where the caller's own D-6 rule withholds
   * this same raw body from the MCP client (BR-5 — a deliberate divergence: this hook runs
   * inside the binding author's own trusted process, not on the MCP boundary).
   *
   * It MUST NOT fire when `invokeRest` returns before any HTTP round-trip completes — no REST
   * connector, missing env/caller placeholder(s), a caller-influenced-baseUrl allowlist
   * rejection, a missing required path parameter, or a `doFetch` exception/timeout (BR-4) —
   * none of those ever produced a response to observe. The same guarantee holds for a policy
   * refusal (#43), which short-circuits in the CALLER before `invokeRest` is entered at all, so
   * this function is never reached and the hook cannot fire.
   *
   * `capabilityId` is `tool.id` — the unsanitized CDL id, never any MCP-sanitized advertised
   * tool name (BR-8). `data` is the exact same value that ends up in `InvokeResult.data`:
   * parsed JSON, the raw text if unparseable, or `undefined` for an empty body.
   *
   * BR-16 / ADD-31 Architectural Challenge: Archstone will NEVER parse or normalize a
   * provider-specific usage/token/cost shape out of this body. Three real LLM APIs already
   * disagree on the field name for the same concept — OpenAI `usage.prompt_tokens`, Anthropic
   * `usage.input_tokens`, Gemini `usageMetadata.promptTokenCount` — and baking any one of them
   * into this hook would tie this repo's release cycle to a third party's API changes on its
   * own timeline. The hook exists specifically so Archstone never has to pick one: the binding
   * author already knows their own backend's shape (they wrote the connector for it) and can
   * extract whatever fields matter themselves from the raw body.
   *
   * Fire-and-forget by design (OQ-1): `invokeRest` never awaits it, and a returned Promise's
   * rejection is swallowed — a slow or hanging hook can never add latency to, or affect the
   * result of, the business call it merely observes (BR-6/BR-7). A throwing or rejecting hook
   * is logged as a single line to stderr (this codebase's existing "stdout is the MCP channel,
   * human output goes to stderr" convention — see `serveStdio`) and never rethrown into
   * `InvokeResult`/`ExecuteResult`/the MCP `CallResult`.
   *
   * Deliberately NOT exposed as a CLI flag on any command, ever (BR-13/OQ-3) — a callback
   * function cannot be expressed as a CLI argument. This is a programmatic-API-only surface,
   * reachable only by code that imports `@archstone/provider-rest`/`@archstone/agent`/
   * `@archstone/runtime` directly and constructs its own options object — a deliberate,
   * structural boundary, not an oversight.
   */
  // Return type is `void | Promise<void>` (not just `void`) so a caller may supply an async
  // callback (OQ-1) — invokeRest never awaits either variant; see fireOnResponse below.
  onResponse?: (info: { capabilityId: string; status: number; data: unknown; durationMs: number }) => void | Promise<void>;
  /**
   * Issue #44 / ADD-44: the `Execution` audit sink — one record per invocation ATTEMPT.
   *
   * **`invokeRest` never reads, calls, or branches on this field.** It rides this bag so that a
   * deployer wires one options object (the same one they already pass `env`/`caller` in) and so
   * that every shipped pass-through — `ExecuteOptions`, `serveStdio`'s `invoke`,
   * `createHttpHandler`'s/`mcpHandler`'s `invoke` — forwards it with zero new plumbing. The
   * record is built and emitted by the two AUDITED CONSUMERS, `@archstone/runtime`'s `callTool`
   * and `@archstone/agent`'s `executeCapability` — the same two sites that call the policy
   * evaluator, so a path that skips the gate also skips the record instead of emitting one that
   * falsely implies a gate ran. Do not look for the emission here, and do not add one:
   * `verifyTool` forwards this identical bag into `invokeRest`, so a sink read in this file
   * would make "the contract prober emits nothing" unimplementable without a special case.
   * (This file now does the same for `authenticated`, whose gate #43 moved out of it.)
   *
   * See `AuditSink` in `@archstone/emitter-support` for the fire-and-forget contract and for
   * the statement that the trail is best-effort and lossy.
   */
  auditSink?: AuditSink;
  /**
   * #44: correlation ids, **passed through to the audit record exactly as the host supplied
   * them** — never synthesized, defaulted, or derived, and never read by `invokeRest`. Absent
   * means the key is absent from the record.
   *
   * **Scope trap, and it differs from `caller`'s.** On `serveStdio` a value set here is
   * per-process and architecturally correct — one child process per conversation. On
   * `createHttpHandler`/`mcpHandler` the handler rebuilds this bag per request as
   * `{...invoke, caller: resolveCaller?.(request)}`: `caller` is overwritten and therefore
   * fails loudly, but these two **survive the spread** and silently stamp every concurrent
   * request with one session. There is no per-request correlation seam on the HTTP surface
   * today and this increment does not invent one.
   */
  sessionId?: string;
  workflowId?: string;
  /**
   * #48: set by `@archstone/runtime`'s `createHttpHandler` for ONE request, when that
   * request's `resolveCaller` (ADD-32) threw instead of returning. `invokeRest` never reads
   * this — like `auditSink`/`sessionId` above, it rides the shared options bag purely so the
   * one caller that needs it (`callTool`, ADD-43's policy evaluation point) can see it without
   * a second, parallel options type.
   *
   * A throwing resolver is strictly less trustworthy than one that returned `undefined`
   * (identity extraction itself failed, not merely "no credential offered"), so this is
   * deliberately NOT the same as an absent `caller`: an absent caller still lets an
   * unauthenticated capability proceed and only fails closed via `policies:[authenticated]`
   * (`authenticated_no_credential`). This flag instead short-circuits `callTool`'s policy step
   * straight to a `policy_unevaluatable` denial for EVERY capability in the request, matching
   * ADD-42 R-11 — an identity-extraction failure must resolve to fail-closed, never to treating
   * the caller as merely anonymous.
   */
  callerResolutionFailed?: boolean;
  /**
   * #45 / ADD-45: TYPE-ONLY, exactly like `auditSink` above. `invokeRest` never reads, calls, or
   * branches on this field — it rides the shared options bag so a deployer wires ONE options
   * object and every shipped pass-through forwards it with zero new plumbing. The state-owning
   * counter/store implementation itself must never live in this package (layer purity, ADD-45)
   * — this is only the deployer-supplied hook, threaded through by the two consumers that call
   * the rate-limit evaluation step (`@archstone/runtime`'s `callTool`, `@archstone/agent`'s
   * `executeCapability` — the same two sites that call the policy evaluator). `verifyTool`
   * deliberately does NOT read this field: rate-limiting `archstone verify` probes is
   * out-of-scope for #45.
   *
   * No-store default: a capability declaring `spec.rateLimit` with this field absent DENIES
   * (fails closed) rather than silently proceeding unlimited — see `evaluateRateLimit` in
   * `@archstone/emitter-support` for the full reasoning.
   */
  rateLimitCounter?: RateLimitCounter;
}

// Issue #39 (OQ-1/OQ-2/BR-6): fire onResponse synchronously but never await it. A thrown
// exception or a rejected returned Promise is caught/swallowed here — logged once to stderr,
// never rethrown — so a misbehaving hook can never delay or break the invocation it observes.
function fireOnResponse(
  onResponse: InvokeOptions["onResponse"],
  info: { capabilityId: string; status: number; data: unknown; durationMs: number },
): void {
  if (!onResponse) return;
  try {
    const maybePromise = onResponse(info);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((err: unknown) => {
        console.error(`archstone: onResponse hook rejected for capability '${info.capabilityId}':`, err);
      });
    }
  } catch (err) {
    console.error(`archstone: onResponse hook threw for capability '${info.capabilityId}':`, err);
  }
}

// Lowercased defensively on both sides — hostnames are case-insensitive (RFC 4343), and a
// caller-supplied tenantId used inside ${caller.NAME} could otherwise bypass an allowlist
// entry authored in a different case.
//
// Exported deliberately, not incidentally: a deployer wiring up `allowedHosts` may want to
// validate/lint their own list against expected hostnames before passing it to `InvokeOptions`,
// so this is kept as stable public surface rather than folded into an unexported helper.
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (h === p) return true;
  if (p.startsWith("*.")) {
    // `p.slice(1)` keeps the leading "." from "*." (so "*.example.com".slice(1) === ".example.com").
    // That leading dot is load-bearing: without it, "evilexample.com".endsWith("example.com")
    // would be a false-positive prefix match. With it, only a real subdomain boundary matches —
    // "tenant-a.example.com".endsWith(".example.com") is true, "evilexample.com" is false.
    return h.endsWith(p.slice(1));
  }
  return false;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// ${caller.NAME} — a second placeholder namespace, resolved against opts.caller instead of
// env, parallel to ENV_RE/resolveEnv (ADD-32 D-2). Kept as a distinct regex/resolver (not a
// unified one) so a missing caller key is reported as "missing caller credential(s)", never
// conflated with "missing env var(s)" in the same error message.
const CALLER_RE = /\$\{caller\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

// {field} placeholders in path and body templates. Restricted to identifier names
// so a JSON body template's own braces (e.g. {"city":"{city}"}) are not mistaken
// for placeholders — only {city} matches.
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// An env var is "missing" only when it is unset (undefined). An empty string is a
// valid value: the placeholder resolves to "" and the call proceeds (BR-8/BR-9).
function resolveEnv(s: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return s.replace(ENV_RE, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}

// ${caller.NAME} — resolved against opts.caller, parallel to resolveEnv. A missing key is
// "missing" only when the caller (or the whole caller object) is absent; an explicit ""
// (e.g. accessToken: "") is a valid, present value (ADD-32 §3/R-6 — same rule as resolveEnv).
// The cast below is only safe because every CallerContext field is `string | undefined` —
// an unmatched name still resolves to `undefined` at runtime. If CallerContext ever gains a
// non-string field, this needs a real `name in caller` narrow, not just a cast.
function resolveCaller(s: string, caller: CallerContext | undefined, missing: Set<string>): string {
  return s.replace(CALLER_RE, (_m, name: string) => {
    const v = caller?.[name as keyof CallerContext];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}

// Serialize a value destined for a query string or a body template placeholder.
// Objects/arrays are JSON-encoded; primitives use their String() form.
function serializeValue(v: unknown): string {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// Interpolate {param} placeholders in the path from input, URL-encoding each value.
// Tracks which fields were consumed (so the query can exclude them) and which
// required params were missing/empty (so the call can fail before any request).
function interpolatePath(
  path: string,
  input: Record<string, unknown>,
): { path: string; consumed: Set<string>; missing: string[] } {
  const consumed = new Set<string>();
  const missing: string[] = [];
  const out = path.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = input[key];
    if (v === undefined || v === null || v === "") {
      missing.push(key);
      return "";
    }
    consumed.add(key);
    return encodeURIComponent(String(v));
  });
  return { path: out, consumed, missing };
}

// Build a query string from every input field NOT consumed by a path placeholder.
// null/undefined fields are omitted; keys and values are URL-encoded. `queryMap` (from
// the connector's `rest.query`, #26) renames a CDL input field to its wire query-param
// name; a field absent from the map is appended under its CDL name unchanged.
function buildQuery(input: Record<string, unknown>, consumed: Set<string>, queryMap?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (consumed.has(k) || v === undefined || v === null) continue;
    params.append(queryMap?.[k] ?? k, serializeValue(v));
  }
  return params.toString();
}

// Honour an authored body template: interpolate {field} placeholders from input.
// Absent/empty fields resolve to "" (defined, does not crash — EC-7).
function interpolateBody(template: string, input: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = input[key];
    if (v === undefined || v === null) return "";
    return serializeValue(v);
  });
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Invoke a compiled capability against its REST backend.
 *
 * **This function performs NO AUTHORIZATION.** It is mechanical: connector presence → env/caller
 * placeholder resolution → caller-influenced-`baseUrl` allowlist → required path params → fetch.
 * It reads no `tool.policies`, branches on no `caller.principal`, and contains no allow/deny
 * logic of any kind.
 *
 * That is deliberate and was previously otherwise: the `policies: [authenticated]` gate used to
 * live here and was **moved** — not copied — to the one shared evaluation point in
 * `@archstone/emitter-support` (#43 / ADD-43 D-4, ADD-42 D-8). Two enforcement sites is exactly
 * the "one answer to where a policy is decided" this project set out to establish, and a check
 * inside an HTTP adapter is invisible to every non-REST connector added later. Callers
 * (`callTool`, `executeCapability`, `verifyTool`) evaluate policy BEFORE reaching this function.
 *
 * Consequence, named rather than hidden: a third party calling this exported function directly
 * against an `authenticated` capability with no caller now **proceeds** to the backend where it
 * previously failed closed. If you are re-adding a gate here because it looks missing — it is
 * not missing, it moved. Add your check at your own call site, or call one of the three
 * consumers above.
 */
export async function invokeRest(
  tool: IRTool,
  input: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const env = opts.env ?? process.env;
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;

  const connector = tool.connector;
  if (!connector || connector.type !== "rest" || !connector.rest) {
    return { ok: false, status: 0, error: `capability '${tool.id}' has no REST connector` };
  }

  // (#43 / ADD-43 D-4) The ADD-32 `policies: [authenticated]` gate that used to sit here has
  // MOVED to `evaluatePolicy` in @archstone/emitter-support — see this function's doc comment.
  // Its predicate (`caller?.accessToken === undefined`, an explicit "" counting as present) and
  // its error text are preserved byte-for-byte there.

  const rest = connector.rest;

  const method = rest.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const missingEnv = new Set<string>();
  const missingCaller = new Set<string>();
  const baseUrl = resolveCaller(resolveEnv(rest.baseUrl ?? "", env, missingEnv), opts.caller, missingCaller);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest.headers ?? {})) {
    headers[k] = resolveCaller(resolveEnv(v, env, missingEnv), opts.caller, missingCaller);
  }
  // NF-1: resolve the body template's env/caller only when a body will actually be sent.
  // GET/HEAD never send their (unused) body template, so an unset ${VAR}/${caller.NAME}
  // inside it must not block the call (BR-2 / EC-8: body is ignored on GET/HEAD).
  const bodyTemplate =
    hasBody && rest.body !== undefined
      ? resolveCaller(resolveEnv(rest.body, env, missingEnv), opts.caller, missingCaller)
      : undefined;

  if (missingEnv.size > 0) {
    return { ok: false, status: 0, error: `missing env var(s): ${[...missingEnv].join(", ")}` };
  }
  if (missingCaller.size > 0) {
    return { ok: false, status: 0, error: `missing caller credential(s): ${[...missingCaller].join(", ")}` };
  }
  if (!baseUrl) {
    return { ok: false, status: 0, error: `capability '${tool.id}': no baseUrl (set it in the binding or via env)` };
  }

  // Security hardening (follow-up to ADD-32, no shipped binding uses this yet — proactive, not
  // a fix for a live incident). `resolveCaller` substitutes caller-supplied values uniformly
  // across baseUrl/headers/query/body — the SAME mechanism as ${VAR}/env. That uniformity is
  // fine for headers/query/body: a caller-controlled value there can only change the CONTENT of
  // an outbound request, never where it goes. `baseUrl` is different — a caller-controlled value
  // there can redirect the ENTIRE request, including any attached credentials/headers, to an
  // arbitrary host of the caller's choosing. So: only when the ORIGINAL, pre-substitution
  // template (not the resolved `baseUrl`) contains `${caller.` do we require the resolved host to
  // match a deployer-configured allowlist — every other binding (the overwhelming majority) is
  // completely unaffected by this check.
  if ((rest.baseUrl ?? "").includes("${caller.")) {
    let resolvedHost: string;
    try {
      resolvedHost = new URL(baseUrl).hostname; // .hostname, not .host — excludes any port
    } catch {
      return {
        ok: false,
        status: 0,
        error: `capability '${tool.id}': baseUrl is not a valid URL after caller-placeholder substitution`,
      };
    }
    const allowedHosts = opts.allowedHosts ?? [];
    const allowed = allowedHosts.some((pattern) => hostMatchesPattern(resolvedHost, pattern));
    if (!allowed) {
      // Fails closed by default — an absent/empty allowedHosts is NOT "allow everything".
      return {
        ok: false,
        status: 0,
        error: `capability '${tool.id}': baseUrl resolves to host '${resolvedHost}', which is not in the caller-influenced-baseUrl allowlist — a binding whose baseUrl contains \${caller.*} requires InvokeOptions.allowedHosts to be configured, or every call fails closed`,
      };
    }
  }

  const { path: interpolatedPath, consumed, missing: missingParams } = interpolatePath(rest.path, input);
  if (missingParams.length > 0) {
    return {
      ok: false,
      status: 0,
      error: `capability '${tool.id}': missing required path parameter(s): ${missingParams.join(", ")}`,
    };
  }

  let url = joinUrl(baseUrl, interpolatedPath);
  if (!hasBody) {
    const qs = buildQuery(input, consumed, rest.query);
    if (qs) url += `?${qs}`;
  }

  if (hasBody && headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  const body = hasBody
    ? bodyTemplate !== undefined
      ? interpolateBody(bodyTemplate, input)
      : JSON.stringify(input)
    : undefined;

  try {
    // BR-9: durationMs strictly bounds doFetch + the response-body read only — nothing
    // before it (env/caller resolution, path interpolation, the allowlist check above).
    const start = Date.now();
    const response = await doFetch(url, { method, headers, body });
    const text = await response.text();
    const durationMs = Date.now() - start;
    const data = text ? safeJson(text) : undefined;
    // BR-1/BR-3/BR-5: fires exactly once here — covering BOTH the ok and non-ok branches —
    // strictly before this function returns (and therefore before any response-mapping/
    // classification logic runs in the caller). Never reached from the catch branch below:
    // no response body exists there to observe (BR-4).
    fireOnResponse(opts.onResponse, { capabilityId: tool.id, status: response.status, data, durationMs });
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? undefined : `backend returned ${response.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, error: `request failed: ${(err as Error).message}` };
  }
}
