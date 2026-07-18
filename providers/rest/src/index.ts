// @archstone/provider-rest — REST adapter (#6)
//
// The first adapter under providers/. Maps a capability's input → an HTTP request
// (from its IR connector) and the HTTP response → a result. REST only. baseUrl,
// headers and auth resolve from env via ${VAR} placeholders. HTTP lives HERE and
// nowhere else — the compiler/IR/emitter never touch it.

import type { IRTool } from "@archstone/compiler";

export interface InvokeResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

export type FetchLike = typeof globalThis.fetch;

export interface InvokeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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

/** Invoke a compiled capability against its REST backend. */
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
  const rest = connector.rest;

  const method = rest.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const missingEnv = new Set<string>();
  const baseUrl = resolveEnv(rest.baseUrl ?? "", env, missingEnv);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest.headers ?? {})) headers[k] = resolveEnv(v, env, missingEnv);
  // NF-1: resolve the body template's env only when a body will actually be sent.
  // GET/HEAD never send their (unused) body template, so an unset ${VAR} inside it
  // must not block the call as missing-env (BR-2 / EC-8: body is ignored on GET/HEAD).
  const bodyTemplate = hasBody && rest.body !== undefined ? resolveEnv(rest.body, env, missingEnv) : undefined;

  if (missingEnv.size > 0) {
    return { ok: false, status: 0, error: `missing env var(s): ${[...missingEnv].join(", ")}` };
  }
  if (!baseUrl) {
    return { ok: false, status: 0, error: `capability '${tool.id}': no baseUrl (set it in the binding or via env)` };
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
    const response = await doFetch(url, { method, headers, body });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      data: text ? safeJson(text) : undefined,
      error: response.ok ? undefined : `backend returned ${response.status}`,
    };
  } catch (err) {
    return { ok: false, status: 0, error: `request failed: ${(err as Error).message}` };
  }
}
