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

import { Registry, applyResponseMapping } from "@archstone/emitter-support";
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
}

export interface ExecuteResult {
  status: "ok" | "degraded" | "violation" | "error";
  data?: Record<string, unknown>; // present on ok/degraded
  missing?: string[]; // present on violation (ADD-12/19 semantics, verbatim)
  degraded?: string[]; // present on degraded
  error?: string; // present on error — invokeRest returned ok:false (InvokeResult.error verbatim)
}

export async function executeCapability(
  registry: Registry,
  capabilityId: string,
  input: Record<string, unknown>,
  opts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const tool = registry.getCapability(capabilityId);
  if (!tool) {
    return { status: "error", error: `unknown capability: ${capabilityId}` };
  }

  // Never assume process.env (Workers-style, ADD-0008 §7.2): default to {} rather than
  // leaving env undefined — invokeRest itself falls back to `process.env` when its own
  // `opts.env` is undefined, which would be wrong on a Worker. An empty env just means
  // every `${VAR}` placeholder resolves as missing, which invokeRest already reports as
  // a normal `ok:false` (mapped below to `status: "error"`).
  const env = opts?.env ?? {};
  const result = await invokeRest(tool, input, {
    env,
    fetchImpl: opts?.fetchImpl,
    caller: opts?.caller,
    allowedHosts: opts?.allowedHosts,
    onResponse: opts?.onResponse,
  });
  if (!result.ok) {
    return { status: "error", error: result.error ?? "invocation failed" };
  }

  if (tool.response) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      return { status: "violation", missing: mapped.missing ?? [] };
    }
    if (mapped.status === "degraded") {
      return { status: "degraded", data: mapped.data, degraded: mapped.degraded ?? [] };
    }
    return { status: "ok", data: mapped.data };
  }

  // No response mapping: raw pass-through (mirrors server.ts's unbound-mapping behavior,
  // ADD-0008 §3). The declared outputSchema is not enforced for these tools.
  const data = result.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { status: "ok", data: data as Record<string, unknown> };
  }
  return { status: "ok" };
}
