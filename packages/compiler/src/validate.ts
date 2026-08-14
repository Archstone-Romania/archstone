// @archstone/compiler — Semantic Validator (#3)
//
// Runs on the Semantic Model (the loaded, shape-valid manifest from #2), not on
// YAML. Semantic-type validity is already enforced structurally by cdl.schema.json
// in #2, so this pass is strictly CROSS-FILE: does the provider resolve? do
// declared IDs match files? do bindings resolve? Errors block; warnings inform.

import type { LoadResult, CapabilityDoc, PolicyDoc } from "@archstone/schema";
import { domainOf, referencedResourceName, resolveResourceName, resourceIndex } from "./resolve";
import { parsePath } from "./path";
import { policyScopesCapability } from "./compile";

/**
 * CDL policy tokens (`cdl.schema.json`'s closed enum) that Archstone does NOT enforce in this
 * version. `authenticated` is deliberately absent — it is enforced, at the one evaluation point
 * (#43 / ADD-43 D-4), so it must not be warned about.
 *
 * BR-40: each remaining token gets exactly one warning per capability that declares it, so a
 * `policies:` list is never mistaken for a list of shipped guarantees by a compliance reviewer
 * reading the manifest as evidence. The list shrinks as tokens gain enforcement (`rate-limited`
 * is #45's); there is deliberately no suppression flag (AC OQ-H — a mechanism whose only
 * purpose is to hide a true statement).
 */
const UNENFORCED_POLICY_TOKENS: Readonly<Record<string, string>> = {
  "rate-limited": "enforcing it needs invocation counting and therefore state — tracked as issue #45",
  "tenant-scoped": "which tenant's data a call may touch is a separate axis from identity, and is deliberately not implemented yet",
  "human-approval": "no approval mechanism exists",
  "consent-required": "no consent mechanism exists",
};

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
}

export function validateSemantics(model: LoadResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const { capabilities: caps, capabilityDocs: docs, bindings, resourceDocs } = model;

  // Index capability docs by id (and catch duplicates).
  const byId = new Map<string, CapabilityDoc>();
  for (const d of docs) {
    const id = d.capability.id;
    const existing = byId.get(id);
    if (existing) {
      diags.push({
        severity: "error",
        code: "duplicate-capability",
        message: `capability '${id}' is defined in more than one file (${existing.file}, ${d.file})`,
      });
    } else {
      byId.set(id, d);
    }
  }

  const providers = new Set(caps?.providers ?? []);
  const declared = new Set(caps?.capabilities ?? []);

  // 1. Provider resolution — every capability.provider must exist in capabilities.yaml.
  for (const d of docs) {
    const p = d.capability.provider;
    if (!p) {
      diags.push({ severity: "error", code: "missing-provider", message: `capability '${d.capability.id}' (${d.file}) declares no provider` });
    } else if (caps && !providers.has(p)) {
      diags.push({ severity: "error", code: "unknown-provider", message: `capability '${d.capability.id}' references provider '${p}' not listed in capabilities.yaml` });
    }
  }

  // 2. Declared <-> files consistency (only meaningful when capabilities.yaml loaded).
  if (caps) {
    for (const id of declared) {
      if (!byId.has(id)) {
        diags.push({ severity: "error", code: "declared-without-file", message: `capabilities.yaml declares '${id}' but no *.capability.yaml defines it` });
      }
    }
    for (const d of docs) {
      if (!declared.has(d.capability.id)) {
        diags.push({ severity: "error", code: "file-not-declared", message: `capability '${d.capability.id}' (${d.file}) is not declared in capabilities.yaml` });
      }
    }
    const usedProviders = new Set(docs.map((d) => d.capability.provider).filter((p): p is string => Boolean(p)));
    for (const p of providers) {
      if (!usedProviders.has(p)) {
        diags.push({ severity: "warning", code: "unused-provider", message: `provider '${p}' is declared but no capability uses it` });
      }
    }
  }

  // 3. Binding resolution + capability-without-binding (NF-1).
  const boundIds = new Set<string>();
  for (const b of bindings) {
    const cid = b.binding.capabilityId;
    boundIds.add(cid);
    if (!byId.has(cid)) {
      diags.push({ severity: "error", code: "binding-without-capability", message: `binding ${b.file} references capability '${cid}' which is not defined` });
    }
  }
  for (const d of docs) {
    if (!boundIds.has(d.capability.id)) {
      diags.push({ severity: "warning", code: "capability-without-binding", message: `capability '${d.capability.id}' has no binding — not invocable until one is added` });
    }
  }

  // 3b. ADD-32 step 8 — advisory: an `authenticated` capability whose REST binding never
  // references a caller placeholder will always fail closed at invoke time (providers/rest's
  // fail-closed gate, D-3). Purely a string-pattern check over the raw binding shape already
  // loaded (`model.bindings`) — no HTTP/auth-scheme interpretation, and NOT a hard schema
  // requirement (warning, not error — R-4: this stays advisory until proven useful in anger).
  for (const b of bindings) {
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    if (!cap || !(cap.capability.policies ?? []).includes("authenticated")) continue;
    const connector = b.binding.connector as { type?: unknown; rest?: Record<string, unknown> } | undefined;
    if (connector?.type !== "rest" || !connector.rest) continue;
    const rest = connector.rest;
    const stringValues: string[] = [];
    if (typeof rest.body === "string") stringValues.push(rest.body);
    for (const map of [rest.headers, rest.query]) {
      if (map && typeof map === "object") {
        for (const v of Object.values(map as Record<string, unknown>)) {
          if (typeof v === "string") stringValues.push(v);
        }
      }
    }
    const hasCallerPlaceholder = stringValues.some((v) => v.includes("${caller."));
    if (!hasCallerPlaceholder) {
      diags.push({
        severity: "warning",
        code: "authenticated-capability-no-caller-placeholder",
        message: `capability '${cid}' declares policies:[authenticated] but its binding never references a caller credential (\${caller.…}) — invocation will always fail closed unless one is added`,
      });
    }
  }

  // 3c. Security-hardening follow-up to ADD-32 step 8, same pattern: a binding whose REST
  // baseUrl references a caller placeholder will always fail closed at invoke time (providers/
  // rest's allowlist guard) unless the invoker configures InvokeOptions.allowedHosts — that
  // configuration is invoke-context, not something the compiler can see or enforce. Purely
  // advisory (warning, never blocks apply/build) and a string-pattern check over the raw binding
  // shape, no HTTP interpretation here either.
  for (const b of bindings) {
    const connector = b.binding.connector as { type?: unknown; rest?: Record<string, unknown> } | undefined;
    if (connector?.type !== "rest" || !connector.rest) continue;
    const baseUrl = connector.rest.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.includes("${caller.")) {
      diags.push({
        severity: "warning",
        code: "caller-influenced-baseurl-no-allowlist",
        message: `binding ${b.file} (capability '${b.binding.capabilityId}')'s baseUrl references a caller credential (\${caller.…}) — invocation will always fail closed unless the invoker configures InvokeOptions.allowedHosts`,
      });
    }
  }

  // 4. Resource resolution (P-7) — every `ref`/`collection`/resource-typed name in a
  // capability's input/output AND in a resource's fields (transitively, since every
  // resource's fields are checked here) must resolve to a loaded resource.
  const index = resourceIndex(resourceDocs);

  // Duplicate resource definitions (same canonical name in more than one file) → warn.
  const seen = new Map<string, string>();
  for (const r of resourceDocs) {
    const name = r.resource.name;
    const first = seen.get(name);
    if (first) {
      diags.push({ severity: "warning", code: "duplicate-resource", message: `resource '${name}' is defined in more than one file (${first}, ${r.file})` });
    } else {
      seen.set(name, r.file);
    }
  }

  const checkFields = (fields: Record<string, unknown> | undefined, domain: string, where: string) => {
    if (!fields) return;
    for (const [fieldName, raw] of Object.entries(fields)) {
      const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
      if (!ref) continue;
      const res = resolveResourceName(ref, domain, index);
      if (res.ok) continue;
      const detail =
        res.reason === "ambiguous"
          ? `resource '${ref}' is ambiguous — it matches both ${res.candidates[0]} and ${res.candidates[1]}; qualify it`
          : `resource '${ref}' is not defined by any *.resource.yaml`;
      diags.push({ severity: "error", code: "unknown-resource", message: `${where} field '${fieldName}' references ${detail}` });
    }
  };

  for (const d of docs) {
    const domain = domainOf(d.capability.id);
    checkFields(d.capability.input, domain, `capability '${d.capability.id}' (${d.file}) input`);
    checkFields(d.capability.output, domain, `capability '${d.capability.id}' (${d.file}) output`);
  }
  for (const r of resourceDocs) {
    checkFields(r.resource.fields, domainOf(r.resource.name), `resource '${r.resource.name}' (${r.file})`);
  }

  // 5. Response-mapping resolution (ADD-12) — for each binding `response:`: the resource
  // resolves (P-7); every `map` key is a real field of it; every path parses; and the bound
  // capability has exactly one output field referencing that resource (D-7 output binding).
  const fieldsByResource = new Map<string, Set<string>>();
  for (const r of resourceDocs) {
    fieldsByResource.set(r.resource.name, new Set(Object.keys(r.resource.fields ?? {})));
  }

  for (const b of bindings) {
    const resp = b.binding.response;
    if (!resp) continue;
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    if (!cap) continue; // binding-without-capability already reported above
    const domain = domainOf(cid);
    const at = `binding ${b.file} response`;

    const rawResource = resp.resource;
    if (typeof rawResource !== "string") continue; // shape-guaranteed by schema; defensive
    const resolved = resolveResourceName(rawResource, domain, index);
    if (!resolved.ok) {
      const detail =
        resolved.reason === "ambiguous"
          ? `is ambiguous — it matches both ${resolved.candidates[0]} and ${resolved.candidates[1]}; qualify it`
          : `is not defined by any *.resource.yaml`;
      diags.push({ severity: "error", code: "unknown-response-resource", message: `${at} maps to resource '${rawResource}' which ${detail}` });
      continue;
    }
    const canonical = resolved.canonical;
    const resourceFields = fieldsByResource.get(canonical);

    // Every map key must be a field of the resolved resource; every path must parse.
    const map = (resp.map ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(map)) {
      if (resourceFields && !resourceFields.has(key)) {
        diags.push({ severity: "error", code: "unknown-response-field", message: `${at} maps '${key}', not a field of resource '${canonical}'` });
      }
      const path = typeof value === "string" ? value : typeof (value as Record<string, unknown>)?.path === "string" ? (value as Record<string, string>).path : undefined;
      if (typeof path === "string") {
        const p = parsePath(path);
        if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} field '${key}' has an invalid JSONPath '${path}': ${p.error}` });
      }
    }
    if (typeof resp.collection === "string") {
      const p = parsePath(resp.collection);
      if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} collection has an invalid JSONPath '${resp.collection}': ${p.error}` });
    }

    // D-7: exactly one output field must reference the mapped resource, so the mapped
    // result has one unambiguous home in the tool's output (structuredContent = outputSchema).
    const targets = Object.entries((cap.capability.output ?? {}) as Record<string, unknown>).filter(([, raw]) => {
      const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
      if (!ref) return false;
      const r = resolveResourceName(ref, domain, index);
      return r.ok && r.canonical === canonical;
    });
    if (targets.length !== 1) {
      const detail = targets.length === 0 ? `no output field references resource '${canonical}'` : `${targets.length} output fields reference resource '${canonical}' (need exactly one)`;
      diags.push({ severity: "error", code: "response-output-mismatch", message: `${at}: ${detail}` });
    } else {
      // #61 (ADD-19's underlying cause, Option B — stop the crash, don't lift the cap): D-7
      // above only checks that exactly one output field references THIS resource; it says
      // nothing about other, unrelated output fields declared alongside it. `applyResponseMapping`
      // (`@archstone/emitter-support/mapping.ts`) always returns `{ [mapping.field]: value }` —
      // exactly one key — while `objectJsonSchema` builds `outputSchema` from EVERY declared
      // `output:` field. A capability with two or more output fields (even with exactly one
      // correctly bound here) ships an `outputSchema` naming N properties against a
      // `structuredContent` carrying one, N-1 of them silently missing — the reference MCP SDK
      // client validates `structuredContent` against `outputSchema` unconditionally and crashes
      // (ADD-19 Rev 2 D-3'/D-6's own precedent, hit again one level up). Refused here, loudly,
      // at authoring time, rather than shipping a capability that crashes its first real caller.
      // Not a lift of the one-resource cap (#61 tracks that as a separate, larger decision) —
      // only a fail-closed stop on the silent version of the same defect.
      const outputFieldCount = Object.keys((cap.capability.output ?? {}) as Record<string, unknown>).length;
      if (outputFieldCount > 1) {
        diags.push({
          severity: "error",
          code: "response-output-extra-fields",
          message: `${at}: capability '${cid}' declares ${outputFieldCount} output fields but this response: block binds only one resource ('${canonical}') — outputSchema would advertise every declared field while structuredContent carries only the mapped one, which crashes the reference MCP client (ADD-19). A response: binding is capped at one resource per capability until #61 decides how to lift it; split into separate capabilities, or remove the extra output field(s), for now.`,
        });
      }
    }
  }

  // 6. Policy documents (#43 / ADD-43 §8.4). Every policy diagnostic lives here — the compiler
  // resolves scope and lowers verbatim, this pass decides what is authorable at all. Errors
  // block `apply`/`build`/`serve`; warnings inform and never block. Nothing here evaluates a
  // policy against a caller: that is the runtime evaluator's single job (BR-7).
  const policies = model.policyDocs ?? [];

  // BR-4 — two documents sharing metadata.id. Mirrors the shipped `duplicate-capability` rule
  // above rather than inventing a new severity.
  const policyById = new Map<string, PolicyDoc>();
  for (const p of policies) {
    const existing = policyById.get(p.metadata.id);
    if (existing) {
      diags.push({
        severity: "error",
        code: "duplicate-policy",
        message: `policy '${p.metadata.id}' is defined in more than one file (${existing.file}, ${p.file})`,
      });
    } else {
      policyById.set(p.metadata.id, p);
    }
  }

  for (const p of policies) {
    const at = `policy '${p.metadata.id}' (${p.file})`;
    const spec = p.spec ?? {};

    // BR-5 — the scope must resolve. `policy.schema.json` marks scope/provider/capabilityId all
    // optional (metadata requires only id/name), so a scope-less policy is shape-valid and
    // semantically meaningless. Refusing it is what prevents the failure this rule is named for:
    // a policy silently applied to nothing while its author believed it was enforced.
    if (p.metadata.scope === undefined) {
      diags.push({
        severity: "error",
        code: "policy-scope-unresolvable",
        message: `${at} declares no metadata.scope, so it applies to nothing — set scope: capability (with capabilityId) or scope: provider (with provider)`,
      });
    } else if (p.metadata.scope === "capability") {
      const cid = p.metadata.capabilityId;
      if (!cid) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} declares scope: capability but no metadata.capabilityId, so it applies to nothing`,
        });
      } else {
        const target = byId.get(cid);
        if (!target) {
          diags.push({
            severity: "error",
            code: "policy-scope-unresolvable",
            message: `${at} scopes capability '${cid}', which no *.capability.yaml defines`,
          });
        } else if (p.metadata.provider !== undefined && target.capability.provider !== p.metadata.provider) {
          // EC-3: a capability-scoped policy may carry a redundant `provider`. When the two
          // agree it is ignored; when they disagree the author's intent is genuinely unknown,
          // so this is an error rather than a silent precedence rule.
          diags.push({
            severity: "error",
            code: "policy-scope-conflict",
            message: `${at} scopes capability '${cid}' but also declares provider '${p.metadata.provider}', while that capability's provider is '${target.capability.provider ?? "?"}' — remove the provider or correct it`,
          });
        }
      }
    } else {
      const prov = p.metadata.provider;
      if (!prov) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} declares scope: provider but no metadata.provider, so it applies to nothing`,
        });
      } else if (caps && !providers.has(prov)) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} scopes provider '${prov}', which is not listed in capabilities.yaml`,
        });
      }
    }

    // BR-10/BR-11 — the pattern grammar is exact, byte-for-byte string equality (BR-9), so two
    // entry shapes must be refused rather than silently matching nothing.
    for (const [key, list] of [
      ["allow", spec.allow],
      ["deny", spec.deny],
    ] as const) {
      for (const entry of list ?? []) {
        if (entry === "") {
          diags.push({
            severity: "error",
            code: "policy-empty-entry",
            message: `${at} has an empty-string entry in ${key} — an empty principal is always an authoring accident (policy.schema.json sets no minLength)`,
          });
        } else if (entry.includes("*")) {
          // The reason this is an ERROR and not a warning: under exact matching, `deny: ["*"]`
          // reads to a human reviewer as "deny everyone" and would in fact deny NO ONE — a
          // silent fail-open in the one list where intent is most safety-critical. Refusing the
          // character also keeps `*` unclaimed, so a future wildcard grammar is a pure widening.
          diags.push({
            severity: "error",
            code: "policy-wildcard-entry",
            message: `${at} has ${key} entry '${entry}' containing '*' — '*' is not a wildcard in this version; principal matching is exact, case-sensitive string equality`,
          });
        }
      }
    }

    // #45 (ADD-45 D-2) — `rateLimit` is now enforced by the same evaluation point as
    // `allow`/`deny` (the state lives outside the pure evaluator, behind a deployer-supplied
    // `RateLimitCounter` — see ADD-45). Both `maxInvocations` and `windowSeconds` are required
    // together: `policy.schema.json` makes neither required on its own, so a document declaring
    // only one is shape-valid but semantically unusable — refusing here, at authoring time, is
    // strictly better than lowering a half-formed rule and denying every call at runtime with a
    // message nobody can act on.
    if (spec.rateLimit !== undefined) {
      const maxInvocations = (spec.rateLimit as Record<string, unknown>).maxInvocations;
      const windowSeconds = (spec.rateLimit as Record<string, unknown>).windowSeconds;
      const validMax = typeof maxInvocations === "number" && Number.isInteger(maxInvocations) && maxInvocations >= 1;
      const validWindow = typeof windowSeconds === "number" && Number.isInteger(windowSeconds) && windowSeconds >= 1;
      if (!validMax || !validWindow) {
        diags.push({
          severity: "error",
          code: "policy-ratelimit-invalid",
          message: `${at} declares spec.rateLimit but is missing (or has an invalid) maxInvocations/windowSeconds — both are required, positive integers`,
        });
      }
    }

    // BR-23 — a NON-EMPTY `constraints` is refused. `policy.schema.json` declares it
    // `additionalProperties: true` with one illustrative key and no grammar whatsoever: nothing
    // states which input field a constraint bounds, with what operator, in what units, or how
    // two compose. Implementing it is not writing an evaluator, it is inventing a permanent
    // comparison language (Rule #11) as a side-task of a plumbing increment. An EMPTY
    // `constraints: {}` is accepted and simply never lowered (ADD-43 D-3).
    if (spec.constraints !== undefined && Object.keys(spec.constraints).length > 0) {
      diags.push({
        severity: "error",
        code: "policy-constraints-unsupported",
        message: `${at} declares spec.constraints, which are not evaluated in this version — no constraint grammar exists yet; remove them or the manifest advertises a control that does not exist`,
      });
    }

    const allow = spec.allow ?? [];
    const deny = spec.deny ?? [];

    // EC-5 — a rule-less policy is evaluable and imposes nothing, but is almost certainly
    // unfinished authoring. Warning, not error: it is legal.
    if (allow.length === 0 && deny.length === 0 && spec.rateLimit === undefined && Object.keys(spec.constraints ?? {}).length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-without-rules",
        message: `${at} declares no allow and no deny — it imposes nothing`,
      });
    }

    // BR-17 — the footgun this warning exists for: an author writes `deny: [...]` and believes
    // the capability is now protected. An ABSENT principal matches no deny entry (ADD-42 D-4),
    // so an anonymous caller proceeds. The rule is correct; the warning is what stops it being
    // a surprise discovered in production.
    if (deny.length > 0 && allow.length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-deny-only",
        message: `${at} declares deny but no allow — an anonymous caller (no principal) matches no deny entry and is therefore ALLOWED; add an allow list to require an identified caller`,
      });
    }

    // EC-7 — the same principal in both lists of one policy. Deny wins (BR-15), so the
    // behaviour is defined; it is still almost certainly an authoring error.
    const contradictions = allow.filter((a) => deny.includes(a));
    if (contradictions.length > 0) {
      diags.push({
        severity: "warning",
        code: "policy-allow-deny-contradiction",
        message: `${at} lists ${contradictions.map((c) => `'${c}'`).join(", ")} in both allow and deny — deny wins, so ${contradictions.length === 1 ? "it is" : "they are"} denied`,
      });
    }
  }

  // BR-46 / ADD-43 D-13 — under intersection semantics, two policies whose non-empty `allow`
  // sets are disjoint make the capability invocable by NOBODY. That is legal and fail-closed
  // (a deployer may genuinely want it during a lockdown), which is why this warns rather than
  // erroring — but without it the author learns of it from a production denial rather than
  // from `apply`.
  for (const d of docs) {
    const scoped = policies.filter(
      (p) => policyScopesCapability(p.metadata, d.capability.id, d.capability.provider ?? "") && (p.spec?.allow?.length ?? 0) > 0,
    );
    if (scoped.length < 2) continue;
    const intersection = scoped
      .map((p) => p.spec.allow ?? [])
      .reduce((acc, list) => acc.filter((entry) => list.includes(entry)));
    if (intersection.length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-disjoint-allow",
        message: `capability '${d.capability.id}' resolves policies ${scoped.map((p) => `'${p.metadata.id}'`).join(", ")} whose allow sets have no principal in common — every policy's allow must be satisfied (intersection, not union), so this capability is invocable by nobody`,
      });
    }
  }

  // 7. BR-40 — declared-but-unenforced CDL policy tokens. The minimum honest fix for #43's own
  // opening complaint, generalized: after this increment and #45, three of the five tokens
  // still have no enforcement and no issue. A warning costs no new primitive (Rule #10) and
  // stops `policies:` reading as a list of shipped guarantees.
  for (const d of docs) {
    for (const token of d.capability.policies ?? []) {
      const why = UNENFORCED_POLICY_TOKENS[token];
      if (!why) continue;
      diags.push({
        severity: "warning",
        code: "unenforced-policy-token",
        message: `capability '${d.capability.id}' (${d.file}) declares policies:[${token}], which is not enforced in this version — ${why}`,
      });
    }
  }

  return diags;
}
