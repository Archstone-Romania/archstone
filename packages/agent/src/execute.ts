// @archstone/agent — execute(): connector invocation + fail-closed response mapping
// (ADD-0008 #28)
//
// Composes invokeRest (@archstone/provider-rest) -> applyResponseMapping
// (@archstone/emitter-support) into a 4-state result — NOT the MCP CallResult shape
// (content/isError/_meta from @archstone/runtime's server.ts). Mirrors that file's
// `callTool` composition (invokeRest -> check ok -> applyResponseMapping -> branch on
// status) but adds a 4th outcome, "error", for transport/connector failures invokeRest
// already distinguishes from a shape VIOLATION (missing env, missing path param, network
// error, non-2xx) — R-8 in ADD-0008's risk table; not in the RFC's original ok|degraded|
// violation sketch.

import {
  Registry,
  applyResponseMapping,
  contractViolationMessage,
  evaluatePolicy,
  auditNow,
  buildExecutionRecord,
  emitExecutionRecord,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
  type ExecutionStatus,
  type ExecutionDenialReason,
} from "@archstone/emitter-support";
import { invokeRest, type FetchLike, type CallerContext, type InvokeOptions } from "@archstone/provider-rest";

export interface ExecuteOptions {
  /** Injected, Workers-style — execute() never falls back to `process.env` (ADD-0008
   *  §2/§7.2). Omitting this (or a var it doesn't contain) means any `${VAR}` connector
   *  placeholder resolves as missing, which surfaces as `status: "error"`, not a crash. */
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** ADD-32: the end user this execute() call acts on behalf of — pure pass-through to
   *  invokeRest (no policy logic here). Omitting it behaves exactly as before unless the
   *  capability declares `policies: [authenticated]`, in which case invokeRest fails closed
   *  with `status: "error"` (no new ExecuteResult variant needed). */
  caller?: CallerContext;
  /** Security-hardening follow-up to ADD-32 — pure pass-through to invokeRest (no policy logic
   *  here). A deployer-level allowlist for the caller-influenced-baseUrl guard (see
   *  `providers/rest`'s `InvokeOptions.allowedHosts`); irrelevant unless a binding's baseUrl
   *  contains `${caller.NAME}`. */
  allowedHosts?: string[];
  /** Issue #39: pure pass-through to invokeRest — no policy/logic added here, exactly like
   *  `caller`/`allowedHosts` above. Type-only imported from `@archstone/provider-rest`; see
   *  `InvokeOptions.onResponse`'s doc-comment there for the full firing/fail-safe contract. */
  onResponse?: InvokeOptions["onResponse"];
  /** Issue #44: the `Execution` audit sink. Unlike `caller`/`allowedHosts`/`onResponse` above
   *  this is NOT a pass-through to `invokeRest` — `executeCapability` is one of the two audited
   *  consumers and builds the record itself, from the same decision it just made. Type-only
   *  imported; see `InvokeOptions.auditSink` and `AuditSink`'s own doc comment (which states
   *  that the trail is best-effort and lossy) for the full contract. */
  auditSink?: InvokeOptions["auditSink"];
  /** Issue #44: correlation ids passed through to the record exactly as supplied, or omitted.
   *  Never synthesized or derived. */
  sessionId?: string;
  workflowId?: string;
}

/** #43 ADD-43 D-11: the embedded rendering of a policy refusal — the `ExecuteResult` sibling of
 *  the MCP path's `_meta["dev.archstone/policy_denied"]`. Same decision, same reason code, same
 *  human message; only the envelope differs, and the two are deliberately NOT forced to
 *  converge (BR-32). `capability` is the unsanitized CDL id (BR-28).
 *
 *  ADD-51 (#51): `reason` also carries `"lifecycle_blocked"` — populated when this call was
 *  refused by the ADD-24 exposure gate below, which is distinct from and runs BEFORE the policy
 *  evaluation point (ADD-43 D-4's boundary between the two vocabularies). This field is no
 *  longer populated only by policy.
 *
 *  ADD-56 (#56): `reason` also carries `"lifecycle_unevaluatable"` — the exposure gate's SECOND
 *  denying outcome, populated when the capability's declared `lifecycle` is a value this build
 *  does not recognize at all (only reachable via a hand-written or forward-versioned `fromIR`
 *  artifact). Distinct from `"lifecycle_blocked"` on purpose: a governance refusal (`retired`)
 *  and a compatibility refusal (unrecognized value) are different facts with different
 *  remediations — see `Exposure.blockedReason`'s doc comment in `@archstone/emitter-support`. */
export interface ExecuteDenial {
  reason: ExecutionDenialReason;
  capability: string;
}

export interface ExecuteResult {
  status: "ok" | "degraded" | "violation" | "error";
  data?: Record<string, unknown>; // present on ok/degraded
  missing?: string[]; // present on violation (ADD-12/19 semantics, verbatim)
  degraded?: string[]; // present on degraded
  error?: string; // present on error — invokeRest returned ok:false (InvokeResult.error verbatim)
  /**
   * #43 (ADD-43 D-11): present iff this call was refused — by the policy evaluation point, OR
   * (ADD-51, #51) by the ADD-24 exposure gate for a `retired` capability, which runs BEFORE
   * policy and is explicitly NOT the policy evaluation point (ADD-43 D-4's boundary). In either
   * case `status` is `"error"` and `error` carries the human message.
   *
   * Additive and optional ON PURPOSE. A fifth `status` value (`"denied"`) would read better
   * against #44's `Execution.status.phase` vocabulary, but `ExecuteResult.status` is a published
   * union: a new member breaks every consumer's exhaustive `switch`, and it would break the
   * shipped `expect(r.status).toBe("error")` assertion — while buying nothing this object does
   * not already provide. `denial !== undefined` is a strictly STRONGER discriminator than a
   * status string, because it also carries the reason.
   */
  denial?: ExecuteDenial;
}

export async function executeCapability(
  registry: Registry,
  capabilityId: string,
  input: Record<string, unknown>,
  opts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const tool = registry.getCapability(capabilityId);
  if (!tool) {
    // #44: no audit record — nothing resolved, so the record's required `capabilityId` would
    // have to carry an unvalidated caller-chosen string. See `callTool`'s twin of this comment.
    return { status: "error", error: `unknown capability: ${capabilityId}` };
  }

  // #44: the attempt clock starts before the exposure gate and before policy evaluation, so a
  // denied attempt has a real start time. Strict no-op with no sink: no clock read, no id, no
  // record, no allocation.
  const auditSink = opts?.auditSink;
  const startedAt = auditSink ? auditNow() : "";
  const audit = (status: ExecutionStatus): void => {
    if (!auditSink) return;
    emitExecutionRecord(
      auditSink,
      buildExecutionRecord({
        tool,
        input,
        // Fixed by this call site, never host-configurable.
        consumer: "function-calling",
        caller: opts?.caller,
        sessionId: opts?.sessionId,
        workflowId: opts?.workflowId,
        startedAt,
        status,
      }),
    );
  };

  // ADD-51 (#51): the SAME ADD-24 exposure gate `callTool` (runtime/src/server.ts) already
  // enforces — `registry.getExposure(tool.id).invocable`, checked immediately after resolution/
  // startedAt and strictly BEFORE `evaluatePolicy`, mirroring `callTool`'s pinned order
  // (ADD-43 BR-34) so a capability that is both `retired` and policy-deniable reports
  // `lifecycle_blocked` here too, never `policy_denied`. Message text is `server.ts`'s, reused
  // verbatim. Before this ADD, a `retired` capability reached the backend on this path and,
  // since #44 shipped, the audit trail recorded `phase: "succeeded"` — manufactured evidence
  // that a withdrawn capability ran cleanly. `verifyTool` (runtime/src/verify.ts) deliberately
  // stays ungated (ADD-51 D-6) — see that file's own comment for why.
  //
  // ADD-56 (#56): `lifecycleExposure` is now TOTAL — an unrecognized `lifecycle` value ALSO sets
  // `invocable:false`, distinguished from `retired` via `exposure.blockedReason`. Text and
  // denialReason for the two cases MUST stay distinct (governance vs. compatibility refusal —
  // see `exposure.ts`'s `Exposure.blockedReason` doc comment); this branch mirrors `server.ts`'s
  // `callTool` textually. The `undefined`-`blockedReason` case (D-4's unknown-id fallback)
  // cannot occur here: `tool` above was already resolved via `getCapability`, which reads the
  // identical `exposureById` map `getExposure` does.
  const exposure = registry.getExposure(tool.id);
  if (!exposure.invocable) {
    if (exposure.blockedReason === "unevaluatable") {
      const text = `capability '${tool.id}' declares a lifecycle this build does not recognize and cannot evaluate — refusing (fail-closed).`;
      audit({ phase: "denied", message: text, denialReason: LIFECYCLE_UNEVALUATABLE_REASON });
      return {
        status: "error",
        error: text,
        denial: { reason: LIFECYCLE_UNEVALUATABLE_REASON, capability: tool.id },
      };
    }
    const text = `capability '${tool.id}' is retired and can no longer be invoked.`;
    audit({ phase: "denied", message: text, denialReason: LIFECYCLE_BLOCKED_REASON });
    return {
      status: "error",
      error: text,
      denial: { reason: LIFECYCLE_BLOCKED_REASON, capability: tool.id },
    };
  }

  // Never assume process.env (Workers-style, ADD-0008 §7.2): default to {} rather than
  // leaving env undefined — invokeRest itself falls back to `process.env` when its own
  // `opts.env` is undefined, which would be wrong on a Worker. An empty env just means
  // every `${VAR}` placeholder resolves as missing, which invokeRest already reports as
  // a normal `ok:false` (mapped below to `status: "error"`).
  // #43 (ADD-43 D-5/D-6): the SAME evaluation point `callTool` and `verifyTool` call — one
  // shared function in @archstone/emitter-support, never a second copy here (the ADD-30 defect
  // class). Called unconditionally, after the exposure gate above and before any connector work,
  // so a denial issues zero outbound requests and no `onResponse` hook fires.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    audit({ phase: "denied", message: decision.denial.message, denialReason: decision.denial.reason });
    return {
      status: "error",
      error: decision.denial.message,
      denial: { reason: decision.denial.reason, capability: tool.id },
    };
  }

  const env = opts?.env ?? {};
  const result = await invokeRest(tool, input, {
    env,
    fetchImpl: opts?.fetchImpl,
    caller: opts?.caller,
    allowedHosts: opts?.allowedHosts,
    onResponse: opts?.onResponse,
  });
  if (!result.ok) {
    const text = result.error ?? "invocation failed";
    audit({ phase: "failed", message: text });
    return { status: "error", error: text };
  }

  if (tool.response) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      const missing = mapped.missing ?? [];
      // The record carries the SAME contract-violation sentence the MCP path returns as tool
      // content. `ExecuteResult` itself carries only `missing` — deliberately, that shape is
      // published — so without the shared helper the two consumers' records would describe one
      // failure in two ways, which is exactly the drift one record builder exists to prevent.
      audit({ phase: "failed", message: contractViolationMessage(tool.id, missing) });
      return { status: "violation", missing };
    }
    if (mapped.status === "degraded") {
      // `succeeded`: every required field was present; only an optional one was absent.
      audit({ phase: "succeeded" });
      return { status: "degraded", data: mapped.data, degraded: mapped.degraded ?? [] };
    }
    audit({ phase: "succeeded" });
    return { status: "ok", data: mapped.data };
  }

  // No response mapping: raw pass-through (mirrors server.ts's unbound-mapping behavior,
  // ADD-0008 §3). The declared outputSchema is not enforced for these tools.
  const data = result.data;
  // #44: `status.output` stays unpopulated — `result.data` is precisely the payload the record
  // must never carry.
  audit({ phase: "succeeded" });
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { status: "ok", data: data as Record<string, unknown> };
  }
  return { status: "ok" };
}
