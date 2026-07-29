// @archstone/runtime — Contract probe runner (ADD-18 / RFC-0006 Phase 2).
//
// `runVerify` replays a bound tool's golden fixture against the LIVE backend and
// derives a health status. This is the only place outside a real MCP invocation that
// makes a network call — always explicit, on demand (`archstone verify`), never
// triggered by `apply`/`serve`. Reuses #12's `applyResponseMapping` verbatim (ADD-18
// D-3/R-4): one mapper, so a probe VIOLATION is exactly what a real call would see.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fingerprintShape, type IRTool, type IRResourceRegistry } from "@archstone/compiler";
import { invokeRest, type InvokeOptions } from "@archstone/provider-rest";
import { evaluatePolicy } from "@archstone/emitter-support";
import { applyResponseMapping } from "./mapping";
// ADD-24: HealthStatus's canonical home moved to @archstone/emitter-support (registry.ts's
// exposure composition needs it, and runtime depends on emitter-support, never the reverse) —
// re-exported here, unchanged, so nothing downstream (e.g. the CLI's `HealthStatus` import
// from "@archstone/runtime") breaks.
import type { HealthStatus } from "@archstone/emitter-support";
export type { HealthStatus } from "@archstone/emitter-support";

export interface ToolVerification {
  capabilityId: string;
  status: HealthStatus;
  detail: string;
  /**
   * #43 (ADD-43 D-14): set iff this verification was refused by the policy evaluation point
   * before any request was issued — i.e. the probe observed **nothing at all** about the
   * backend's contract.
   *
   * Why an additive optional field rather than a fourth `HealthStatus` value: `HealthStatus` is
   * a CLOSED set already consumed by ADD-24's `combineExposure` and by ADD-20's published
   * `archstone verify --json` shape, so a `"denied"` member would take a published CLI contract
   * and the exposure severity ordering with it. `red` stays correct for the OPERATOR-facing
   * report — they asked "is this binding healthy?" and the honest answer is "I could not
   * establish that" (D-7).
   *
   * What this flag exists to stop is that `red` travelling ONWARD into an AGENT-facing surface.
   * `readHealthSnapshot` (registry.ts) skips any entry carrying it, so the tool ends up with no
   * health entry at all, `combineExposure` leaves its exposure untouched, and no hint is
   * appended to its advertised description. Without it, the documented ADD-24 D-8 workflow
   * (`archstone verify --json` > `.archstone-health.json`, then serve) would append
   * `"binding health: red — the last contract verification failed"` at the highest severity to
   * a policy-gated tool's description, for EVERY caller including permitted ones — a statement
   * that is factually false (no verification occurred) and that makes policy affect listing,
   * which BR-36 forbids. Because the CLI supplies no caller, that is the DEFAULT outcome for
   * any `allow`-bearing capability, not a corner case.
   *
   * The failure is silent: nothing throws, no exit code changes, an agent just reads a false
   * warning. `runtime/test/lifecycle.integration.test.ts` asserts it.
   */
  policyDenied?: true;
}

export interface GoldenFixture {
  capabilityId: string;
  recordedAt?: string;
  request: Record<string, unknown>;
  expects?: { collectionNonEmpty?: boolean };
}

function readFixture(dir: string, path: string): GoldenFixture | undefined {
  try {
    return JSON.parse(readFileSync(resolve(dir, path), "utf8")) as GoldenFixture;
  } catch {
    return undefined;
  }
}

/** Verify one tool's contract against the live backend. Returns green/yellow/red — never
 *  throws (a network/fs failure is itself a red result, not an exception the CLI must catch). */
export async function verifyTool(tool: IRTool, dir: string, resources: IRResourceRegistry, opts?: InvokeOptions): Promise<ToolVerification> {
  const base = { capabilityId: tool.id };
  const contract = tool.contract;
  if (!contract) return { ...base, status: "red", detail: "no contract: declared — nothing to verify" };

  const fixture = readFixture(dir, contract.probeFixture);
  if (!fixture) return { ...base, status: "red", detail: `fixture not found or unreadable: ${contract.probeFixture}` };

  // #43 (ADD-43 D-6): the contract prober is the THIRD invocation consumer, and it must route
  // through the same evaluation point as `callTool`/`executeCapability`. A probe makes a real
  // call with real credentials and is `authenticated`-gated today only because that gate lives
  // inside `invokeRest`; moving the gate (D-4) would silently un-gate `archstone verify` and the
  // published `runVerify()` unless this call exists. Placed immediately before `invokeRest`, so
  // "no contract" / "fixture not found" keep reporting themselves first.
  //
  // ADD-51 (#51) D-6, deliberately, do NOT "fix" this into a third exposure gate: unlike
  // `callTool`/`executeCapability`, `verifyTool` does not read `registry.getExposure(tool.id)`
  // and a `lifecycle: retired` capability is still probed here exactly like a `stable` one. Two
  // reasons, both load-bearing. (1) `verifyTool` never emits an `Execution` audit record under
  // any outcome, so the manufactured-evidence harm ADD-51 exists to close is structurally
  // impossible on this path regardless of lifecycle wiring. (2) Gating it would make
  // `archstone verify`'s CI release gate (`reports.some(r => r.status === "red")`,
  // `cli/src/index.ts`, no escape hatch) fail permanently the day a manifest retires a
  // `contract:`-bearing capability without also deleting its contract block — a real,
  // permanent regression for a routine operational event. Named residual risk, filed as **#54**,
  // not solved here.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    // `red`, with a detail textually distinguishable from the `live request failed:` prefix
    // below — because no live request was made (BR-37). `policyDenied` keeps this out of the
    // health snapshot entirely (D-14, see the field's doc comment).
    return {
      ...base,
      status: "red",
      detail: `policy denied before any request was made: ${decision.denial.message}`,
      policyDenied: true,
    };
  }

  const result = await invokeRest(tool, fixture.request, opts);
  if (!result.ok) return { ...base, status: "red", detail: `live request failed: ${result.error ?? `status ${result.status}`}` };

  const liveFingerprint = fingerprintShape(result.data);
  const fingerprintChanged = liveFingerprint !== contract.fingerprint;

  if (!tool.response) {
    // No response mapping to validate against — fingerprint drift is all we can see.
    return fingerprintChanged
      ? { ...base, status: "yellow", detail: `response shape changed (fingerprint ${contract.fingerprint} → ${liveFingerprint})` }
      : { ...base, status: "green", detail: "fingerprint unchanged" };
  }

  const mapped = applyResponseMapping(tool, result.data, resources);
  if (mapped.status === "violation") {
    return { ...base, status: "red", detail: `contract violation: missing required field(s) ${(mapped.missing ?? []).join(", ")}` };
  }

  if (fixture.expects?.collectionNonEmpty) {
    const field = tool.response.field;
    const value = mapped.data?.[field];
    const empty = Array.isArray(value) ? value.length === 0 : value === undefined || value === null;
    if (empty) return { ...base, status: "red", detail: `expected a non-empty '${field}' collection; got none` };
  }

  if (mapped.status === "degraded") {
    return { ...base, status: "yellow", detail: `degraded: optional field(s) absent — ${(mapped.degraded ?? []).join(", ")}` };
  }
  if (fingerprintChanged) {
    return { ...base, status: "yellow", detail: `response shape changed (fingerprint ${contract.fingerprint} → ${liveFingerprint}) but mapping still resolves` };
  }
  return { ...base, status: "green", detail: "fingerprint unchanged, mapping OK" };
}

/** Verify every contract-bearing tool in a registry. */
export async function runVerify(
  tools: IRTool[],
  dir: string,
  resources: IRResourceRegistry,
  opts?: InvokeOptions,
): Promise<ToolVerification[]> {
  const contractBearing = tools.filter((t) => t.contract);
  return Promise.all(contractBearing.map((t) => verifyTool(t, dir, resources, opts)));
}
