// @archstone/runtime — MCP server construction (fs-free)
//
// Builds an MCP Server from a Registry and routes invocations through the REST provider
// (#6). This is the ONLY place the MCP SDK appears (alongside stdio's transport wiring in
// mcp.ts and the /http subpath's transport wiring in http.ts) — semantic-type → JSON-Schema
// lowering itself now lives in @archstone/emitter-support (ADD-0008 #27), never here.
//
// Extracted out of mcp.ts (ADD-0008 #27) specifically so this module's graph never reaches
// registry.ts's buildRegistry/@archstone/schema `load()` (the fs edge) — only stdio's
// `serveStdio` (mcp.ts) needs disk access. `http.ts` (the /http subpath) imports only this
// file, so a consumer depending on that subpath alone stays fs-free.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Registry,
  inputJsonSchema,
  objectJsonSchema,
  applyResponseMapping,
  contractViolationMessage,
  evaluatePolicy,
  auditNow,
  buildExecutionRecord,
  emitExecutionRecord,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
  type ExecutionStatus,
  type PolicyDecision,
} from "@archstone/emitter-support";
import { invokeRest, type InvokeOptions } from "@archstone/provider-rest";

type JsonSchema = Record<string, unknown>;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

/** The MCP tool list: only invocable (bound) capabilities become tools — Registry's
 *  `invocableTools()` (ADD-30 D-3) is the single source of truth shared by this function
 *  (what's listed) and `callTool` (what's resolvable, via `getCapability`), keeping the two
 *  consistent. Input and output fields lower against the IR resource registry, so a
 *  `collection: Stay` output emits a typed, described `outputSchema` (not a bare
 *  `{type:object}`).
 *
 *  ADD-24: a bound tool whose combined exposure (`registry.getExposure`, lifecycle + optional
 *  health) is `listed:false` (lifecycle `experimental`/`retired`) is dropped from the returned
 *  list entirely — unlisted, per D-10, though `experimental` remains callable by id (see
 *  `callTool`). A tool carrying a `hint` (beta/deprecated, or a yellow/red health reading) has
 *  its text appended to `description` — the only MCP-specific rendering of the neutral
 *  exposure the emitter-support layer computed. */
export function toolDefinitions(registry: Registry): McpToolDef[] {
  const resources = registry.ir.resources;
  return registry
    .invocableTools()
    .filter(({ tool: t }) => registry.getExposure(t.id).listed)
    .map(({ name, tool: t }) => {
      const hint = registry.getExposure(t.id).hint;
      const def: McpToolDef = {
        name,
        description: hint ? `${t.description} (${hint.text})` : t.description,
        inputSchema: inputJsonSchema(t.input, resources),
      };
      if (t.output.length > 0) def.outputSchema = objectJsonSchema(t.output, resources);
      return def;
    });
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

/** #19 ADD-19 Rev 2 D-6: the namespaced `_meta` key a VIOLATION result's structured error
 *  object is carried under. Never populated on `structuredContent` (D-3′) — the reference
 *  MCP SDK client validates `structuredContent` against `outputSchema` whenever the tool
 *  declares one, regardless of `isError`, so a non-conforming error object there crashes the
 *  client. `_meta` is untouched by that validation and passes through the client's zod parse
 *  unstripped (`ResultSchema`/`RequestMetaSchema` are `z.looseObject`). */
export const CONTRACT_VIOLATION_META_KEY = "dev.archstone/contract_violation";

/** ADD-24 D-11: the namespaced `_meta` key a `retired` (or otherwise `invocable:false`)
 *  tool's rejection is carried under — reuses `CONTRACT_VIOLATION_META_KEY`'s precedent
 *  (ADD-19 Rev 2 D-3′/D-6) verbatim: never `structuredContent`, so the reference SDK client's
 *  unconditional `structuredContent`-against-`outputSchema` validation never sees it. A
 *  distinct key (not `CONTRACT_VIOLATION_META_KEY`) so a client distinguishes "this call was
 *  blocked before any connector work" from "the provider's response violated the contract". */
export const LIFECYCLE_BLOCKED_META_KEY = "dev.archstone/lifecycle_blocked";

/** ADD-56 D-2/OQ-56-B: the namespaced `_meta` key an unrecognized-lifecycle rejection is
 *  carried under — a DISTINCT key from `LIFECYCLE_BLOCKED_META_KEY`, mirroring
 *  `POLICY_DENIED_META_KEY` vs. `LIFECYCLE_BLOCKED_META_KEY` being genuinely distinct keys
 *  rather than one key with a varying `error` string inside it. `retired` (a governance
 *  refusal) and an unrecognized `lifecycle` (a compatibility refusal) are different facts with
 *  different remediations and must be trivially distinguishable to a client — see
 *  `exposure.ts`'s `Exposure.blockedReason` doc comment. */
export const LIFECYCLE_UNEVALUATABLE_META_KEY = "dev.archstone/lifecycle_unevaluatable";

/** #43 ADD-43: the namespaced `_meta` key a POLICY denial is carried under — the third use of
 *  the ADD-19 Rev 2 D-3′/D-6 precedent, verbatim: never `structuredContent`, because the
 *  reference SDK client validates that against the tool's `outputSchema` unconditionally (not
 *  gated on `isError`) and an error object there crashes it. A distinct key from the other two
 *  so a client can tell "refused by policy before any connector work" from "blocked by
 *  lifecycle" from "the provider's response violated the contract" — the three are mutually
 *  exclusive on one call (BR-27). The object discloses the reason code and the capability id
 *  and NOTHING about the policy itself: no metadata.id, no allow/deny entry, no other
 *  principal's identifier (BR-30, Rule #7 — the MCP client is the untrusted side). */
export const POLICY_DENIED_META_KEY = "dev.archstone/policy_denied";

/** Route an MCP tool call to the REST provider and format the result as MCP content. */
export async function callTool(
  registry: Registry,
  name: string,
  args: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<CallResult> {
  const tool = registry.getCapability(name);
  if (!tool) {
    // #44: NO audit record. `metadata.capabilityId` is required and the only value available
    // here is an unvalidated, caller-chosen string that is not a CDL id — writing it there
    // would put unbounded attacker-controlled values into the audit log's primary correlation
    // key, in a file a compliance process treats as evidence. An `Execution` record audits a
    // capability invocation attempt; a call naming no capability is a protocol-level event and
    // belongs to the host's own mount-point instrumentation. Named residual, deliberately
    // accepted: tool-name probing (and the collision defence, which also lands here) is
    // invisible to the audit trail.
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }

  // #44: the attempt clock starts HERE — before the exposure gate and before policy evaluation,
  // so every refused attempt still carries a real `startedAt` and can be placed on a timeline.
  // With no sink configured this is a strict no-op: no clock read, no id, no record, no
  // allocation, and every result byte-for-byte what it was before this increment.
  const auditSink = opts?.auditSink;
  const startedAt = auditSink ? auditNow() : "";
  const audit = (status: ExecutionStatus): void => {
    if (!auditSink) return;
    emitExecutionRecord(
      auditSink,
      buildExecutionRecord({
        tool,
        input: args,
        // Fixed by this call site, never host-configurable: an auditor must be able to trust
        // that a record claiming `mcp` came from the MCP path. `mcpHandler` mounts this same
        // path and therefore also records `mcp` — the value names the protocol surface the call
        // arrived on, not the npm package that mounted it.
        consumer: "mcp",
        caller: opts?.caller,
        sessionId: opts?.sessionId,
        workflowId: opts?.workflowId,
        startedAt,
        status,
      }),
    );
  };

  // ADD-24 D-10/D-11: `lifecycle: retired` sets `invocable:false` (health never does, D-9) —
  // checked immediately after resolution, before any connector/response work, same call-site
  // discipline the `contract_violation` check already uses downstream.
  //
  // ADD-56 D-1/D-2: `lifecycleExposure` is now TOTAL — an unrecognized `lifecycle` value (only
  // reachable via a hand-written or forward-versioned `fromIR` artifact, ADD-0008 D-2) ALSO sets
  // `invocable:false`, distinguished from `retired` by `exposure.blockedReason`. The two are
  // different facts with different remediations (governance vs. compatibility — see
  // `exposure.ts`'s `Exposure.blockedReason` doc comment) and MUST NOT share a message or a
  // `denialReason`. `exposure.blockedReason === "unevaluatable"` is the only branch this can take
  // here: the `undefined` case (D-4's unknown-id fallback) cannot occur, because `tool` above was
  // already resolved via `getCapability`, which reads the identical `exposureById` map.
  const exposure = registry.getExposure(tool.id);
  if (!exposure.invocable) {
    if (exposure.blockedReason === "unevaluatable") {
      const text = `capability '${tool.id}' declares a lifecycle this build does not recognize and cannot evaluate — refusing (fail-closed).`;
      // #44: `denied`, never `failed` — refusing on a compatibility gap is not a backend
      // failure. Deliberately distinct denialReason/message/meta-key from the `retired` branch
      // below (ADD-56 D-2/D-3) — never `LIFECYCLE_BLOCKED_REASON`.
      audit({ phase: "denied", message: text, denialReason: LIFECYCLE_UNEVALUATABLE_REASON });
      return {
        content: [{ type: "text", text }],
        _meta: {
          [LIFECYCLE_UNEVALUATABLE_META_KEY]: { error: "lifecycle_unevaluatable", capability: tool.id, lifecycle: tool.lifecycle },
        },
        isError: true,
      };
    }
    const text = `capability '${tool.id}' is retired and can no longer be invoked.`;
    // #44: `denied`, never `failed` — a refusal by lifecycle is a refusal by governance, and
    // recording it as a failure would conflate it with "the backend broke" in the one log where
    // that distinction is the entire product. This gate is the SECOND (and only other) producer
    // of `phase: "denied"`, and the reason code the policy evaluator can never return. It runs
    // before policy deliberately, so a capability that is both retired and policy-denied records
    // `lifecycle_blocked`, matching the pinned gate order.
    audit({ phase: "denied", message: text, denialReason: LIFECYCLE_BLOCKED_REASON });
    return {
      content: [{ type: "text", text }],
      _meta: { [LIFECYCLE_BLOCKED_META_KEY]: { error: "lifecycle_blocked", capability: tool.id, lifecycle: tool.lifecycle } },
      isError: true,
    };
  }

  // #43 (ADD-43 D-5/D-6): THE policy evaluation point, called unconditionally — for every tool,
  // including one with no resolved policy, because `authenticated` enforcement now lives here
  // rather than inside `invokeRest` (D-4). Deliberately AFTER the ADD-24 exposure gate above, so
  // a `retired` capability reports `lifecycle_blocked` and never `policy_denied` (BR-34), and
  // strictly BEFORE `invokeRest`, so a denial does zero connector work: no env/caller
  // resolution, no URL building, no fetch, and no `onResponse` firing (BR-25).
  // #48: a `resolveCaller` that THREW for this request (rather than returning, even
  // `undefined`) short-circuits straight to a `policy_unevaluatable` denial for every
  // capability, bypassing `evaluatePolicy` entirely — identity extraction itself failed here,
  // which is strictly less trustworthy than "no credential offered" and must fail closed
  // regardless of whether THIS capability happens to declare `policies:[authenticated]`
  // (ADD-42 R-11). Reuses the evaluator's own reason code and this function's existing
  // policy-denial response shaping verbatim — no parallel response path.
  const decision: PolicyDecision = opts?.callerResolutionFailed
    ? {
        allowed: false,
        denial: {
          reason: "policy_unevaluatable",
          message: `capability '${tool.id}' could not be evaluated — caller identity could not be established (resolveCaller failed) — refusing (fail-closed).`,
        },
      }
    : evaluatePolicy(tool, {
        principal: opts?.caller?.principal,
        credentialPresent: opts?.caller?.accessToken !== undefined,
      });
  if (!decision.allowed) {
    // #44: the evaluator's OWN reason code, copied verbatim — no re-spelling, no mapping table,
    // no superset for the policy case. The message is likewise the evaluator's, unaltered:
    // the record copies, it never authors.
    audit({ phase: "denied", message: decision.denial.message, denialReason: decision.denial.reason });
    return {
      content: [{ type: "text", text: decision.denial.message }],
      _meta: {
        [POLICY_DENIED_META_KEY]: {
          error: "policy_denied",
          // `tool.id` — the unsanitized CDL id, never the MCP-sanitized advertised `name`
          // lookup key (BR-28, mirroring ADD-19 and ADD-30 BR-7).
          capability: tool.id,
          reason: decision.denial.reason,
        },
      },
      isError: true,
    };
  }

  const result = await invokeRest(tool, args, opts);
  if (!result.ok) {
    // #44: every attempt that never completed a usable round-trip — unbound capability, missing
    // env var, missing caller credential, no baseUrl, an allowlist rejection, a missing path
    // parameter, a network error, a non-2xx response — records `failed` carrying the shipped
    // error text verbatim, so a deployer greps the audit log and finds the same string the
    // agent was shown.
    const text = result.error ?? "invocation failed";
    audit({ phase: "failed", message: text });
    return { content: [{ type: "text", text }], isError: true };
  }

  // #12 (ADD-12): a binding with a `response:` mapping is now MAPPED + VALIDATED against the
  // resource — the outputSchema (ADD-11) becomes an enforced contract, not just declared.
  if (tool.response) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      // Fail closed (D-6): the declared output shape was not met — no raw pass-through.
      const missing = mapped.missing ?? [];
      // The text is unchanged byte-for-byte; it moved into a shared helper (#44) only so the
      // embedded consumer, whose own result carries no text, records the identical sentence.
      const text = contractViolationMessage(tool.id, missing);
      // #19 (ADD-19 Rev 2 D-3′/D-6): structured error object lives in `_meta`, never
      // `structuredContent` — the reference SDK client validates `structuredContent` against
      // the tool's `outputSchema` unconditionally (not gated on `isError`), so a VIOLATION
      // object there (which never conforms to the success outputSchema) crashes the client
      // (verified live against the SDK's own InMemoryTransport, R2.0/R2.2). `capability` is
      // `tool.id`, the unsanitized CDL id — never the MCP-sanitized `name` lookup key (BR-7).
      // #44: a VIOLATION is `failed` — the declared output shape was not met.
      audit({ phase: "failed", message: text });
      return {
        content: [{ type: "text", text }],
        _meta: { [CONTRACT_VIOLATION_META_KEY]: { error: "contract_violation", capability: tool.id, missing } },
        isError: true,
      };
    }
    const content: CallResult["content"] = [{ type: "text", text: JSON.stringify(mapped.data, null, 2) }];
    if (mapped.status === "degraded") {
      content.push({ type: "text", text: `note: optional field(s) absent (degraded): ${(mapped.degraded ?? []).join(", ")}` });
    }
    // #44: `degraded` records `succeeded`, NOT `failed` — every *required* field was present and
    // an optional one was not, so the invocation succeeded. Pinned in a comment because
    // "degraded" reads like a failure and the next reader will guess otherwise.
    audit({ phase: "succeeded" });
    return { content, structuredContent: mapped.data, isError: false };
  }

  // No response mapping: today's raw pass-through (rollout-safe). The declared outputSchema is
  // NOT yet enforced for these tools — add a `response:` block to close the loop (ADD-12 R-3).
  const out: CallResult = { content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }], isError: false };
  if (tool.output.length > 0) {
    const data = result.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      out.structuredContent = data as Record<string, unknown>;
    }
  }
  // #44: `status.output` is deliberately NOT populated here (nor anywhere) — `result.data` is
  // exactly the payload the record must never carry.
  audit({ phase: "succeeded" });
  return out;
}

/** Build an MCP Server that lists and invokes the registry's tools. */
export function createMcpServer(registry: Registry, opts?: InvokeOptions): Server {
  const server = new Server({ name: "archstone", version: "0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(registry) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(registry, req.params.name, args, opts);
    return result as CallToolResult;
  });

  return server;
}
