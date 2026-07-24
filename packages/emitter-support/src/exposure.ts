// @archstone/emitter-support — lifecycle -> exposure lowering (ADD-24)
//
// The one pure, MCP-SDK-free, fs-free mechanism mapping a tool's authored `lifecycle`
// (compile-time, IR-carried) — and, only at the Registry layer, an optional binding-health
// reading (runtime-computed, never IR — ADD-24 D-7) — to a target-agnostic EXPOSURE:
//   - listed:    should this tool appear in a discovery listing (e.g. MCP tools/list)?
//   - invocable: may this tool be called at all?
//   - hint:      an optional severity + human-readable text an emitter MAY surface
//                (e.g. appended to an MCP tool's `description`).
//
// This is the ONLY place lifecycle/health compose into a listing/invocation decision.
// Never re-implemented per emitter (ADD-24 D-6, R-5) — MCP-specific rendering (how a hint
// becomes description text, how tools/list filters, the `_meta` rejection shape) belongs
// only in @archstone/runtime's server.ts, never here.

import type { Lifecycle } from "@archstone/compiler";

/** Binding health, as already produced by `archstone verify` (`ToolVerification.status`,
 *  runtime/src/verify.ts) — re-declared here as the canonical, dependency-direction-safe
 *  home (runtime depends on emitter-support, never the reverse) so both packages share one
 *  definition instead of two independently-maintained unions. */
export type HealthStatus = "green" | "yellow" | "red";

export type HintLevel = "caution" | "deprecation";

export interface ExposureHint {
  level: HintLevel;
  text: string;
}

/** A tool's neutral exposure — what any emitter (MCP today; OpenAPI/docs later) does with
 *  it is that emitter's own concern. */
export interface Exposure {
  listed: boolean;
  invocable: boolean;
  hint?: ExposureHint;
}

/** Severity order, defined once (`none < caution < deprecation`) so health composition
 *  (`combineExposure`, below) can raise — never invent or lower — a lifecycle-derived hint. */
const SEVERITY_ORDER: Record<"none" | HintLevel, number> = { none: 0, caution: 1, deprecation: 2 };

function severityOf(hint: ExposureHint | undefined): number {
  return SEVERITY_ORDER[hint?.level ?? "none"];
}

/**
 * Map a capability's authored `lifecycle` (a pure compile-time fact, ADD-24 D-1) to its
 * exposure. Per-state behavior (ADD-24 D-10 / capability-lifecycle.md §3):
 *  - experimental → listed:false, invocable:true — unlisted but reachable by id ("opt-in
 *    by knowing it"; no opt-in flag/Policy mechanism exists to make this conditional).
 *  - beta         → listed:true,  invocable:true, hint: caution.
 *  - stable       → listed:true,  invocable:true, no hint.
 *  - deprecated   → listed:true,  invocable:true, hint: deprecation. The draft's "or hidden
 *    by Policy" branch is explicitly deferred (ADD-24 D-10/R-3) — no Policy engine exists.
 *  - retired      → listed:false, invocable:false — the ONLY state that blocks invocation
 *    (ADD-24 D-10); this is the sole gate `callTool` must enforce beyond bindings.
 *
 * R-4 (ADD-24): `beta`/`deprecated` differ only in hint text, not listed/invocable — a valid
 * MVP simplification (every one of the five states still gets a faithful, distinct lowering
 * as a whole), not a missing behavior.
 */
export function lifecycleExposure(lifecycle: Lifecycle): Exposure {
  switch (lifecycle) {
    case "experimental":
      return { listed: false, invocable: true };
    case "beta":
      return { listed: true, invocable: true, hint: { level: "caution", text: "beta — interface may still change" } };
    case "stable":
      return { listed: true, invocable: true };
    case "deprecated":
      return { listed: true, invocable: true, hint: { level: "deprecation", text: "deprecated — avoid new usage" } };
    case "retired":
      return { listed: false, invocable: false };
  }
}

function healthHint(health: HealthStatus): ExposureHint | undefined {
  switch (health) {
    case "red":
      return { level: "deprecation", text: "binding health: red — the last contract verification failed" };
    case "yellow":
      return { level: "caution", text: "binding health: yellow — the last contract verification was degraded" };
    case "green":
      return undefined;
  }
}

/**
 * Compose a tool's lifecycle-derived exposure with its (optional) binding health reading.
 * Health only ever RAISES hint severity (`max(lifecycle-derived, health-derived)`, ADD-24 §7
 * step 5) — it NEVER sets `invocable:false` and NEVER touches `listed` (ADD-24 D-9):
 * invocation-blocking authority stays exclusively `lifecycle: retired`'s (D-10), because the
 * always-fresh, per-call safety net is the response-mapping validator (ADD-12/19), not a
 * possibly-stale cached health snapshot (ADD-24 R-2). Absent health (no snapshot, or the tool
 * has no contract) leaves `base` untouched.
 */
export function combineExposure(base: Exposure, health?: HealthStatus): Exposure {
  if (!health) return base;
  const hint = healthHint(health);
  if (!hint || severityOf(hint) <= severityOf(base.hint)) return base;
  return { ...base, hint };
}
