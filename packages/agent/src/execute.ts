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
  type ExecutionStatus,
  type PolicyDenialReason,
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
 *  converge (BR-32). `capability` is the unsanitized CDL id (BR-28). */
export interface ExecuteDenial {
  reason: PolicyDenialReason;
  capability: string;
}

export interface ExecuteResult {
  status: "ok" | "degraded" | "violation" | "error";
  data?: Record<string, unknown>; // present on ok/degraded
  missing?: string[]; // present on violation (ADD-12/19 semantics, verbatim)
  degraded?: string[]; // present on degraded
  error?: string; // present on error — invokeRest returned ok:false (InvokeResult.error verbatim)
  /**
   * #43 (ADD-43 D-11): present iff this call was refused by the policy evaluation point, in
   * which case `status` is `"error"` and `error` carries the human message.
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

  // #44: the attempt clock starts before policy evaluation, so a denied attempt has a real
  // start time. Strict no-op with no sink: no clock read, no id, no record, no allocation.
  //
  // NOTE for whoever reads a trail produced here: this consumer has **no exposure gate** — it
  // never had one and #43 deliberately did not add one — so a `retired` capability invoked
  // through the embedded SDK reaches the backend and records `phase: "succeeded"`, while the
  // same capability over MCP records `denied`/`lifecycle_blocked`. That asymmetry is not this
  // increment's to fix; what IS new is that the audit trail now turns it into written evidence
  // an auditor will read. Tracked separately.
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

  // Never assume process.env (Workers-style, ADD-0008 §7.2): default to {} rather than
  // leaving env undefined — invokeRest itself falls back to `process.env` when its own
  // `opts.env` is undefined, which would be wrong on a Worker. An empty env just means
  // every `${VAR}` placeholder resolves as missing, which invokeRest already reports as
  // a normal `ok:false` (mapped below to `status: "error"`).
  // #43 (ADD-43 D-5/D-6): the SAME evaluation point `callTool` and `verifyTool` call — one
  // shared function in @archstone/emitter-support, never a second copy here (the ADD-30 defect
  // class). Called unconditionally, before any connector work, so a denial issues zero outbound
  // requests and no `onResponse` hook fires. Note there is deliberately no exposure gate here:
  // `executeCapability` has never had one and #43 does not add one (BR-35 — that asymmetry is
  // ADD-24's to answer and is orthogonal to policy).
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
