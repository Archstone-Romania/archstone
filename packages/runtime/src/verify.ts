// @archstone/runtime — Contract probe runner (ADD-18 / RFC-0006 Phase 2).
//
// `runVerify` replays a bound tool's golden fixture against the LIVE backend and
// derives a health status. This is the only place outside a real MCP invocation that
// makes a network call — always explicit, on demand (`archstone verify`), never
// triggered by `apply`/`serve`. Reuses #12's `applyResponseMapping` verbatim (ADD-18
// D-3/R-4): one mapper, so a probe VIOLATION is exactly what a real call would see.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeShape,
  diffShape,
  fingerprintShape,
  fingerprintShapeMap,
  hasShapeDrift,
  shapeDriftSummary,
  type IRContract,
  type IRTool,
  type IRResourceRegistry,
  type ShapeDiff,
  type ShapeMap,
} from "@archstone/compiler";
import { invokeRest, type InvokeOptions } from "@archstone/provider-rest";
import { evaluatePolicy, lifecycleExposure } from "@archstone/emitter-support";
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
  /**
   * #114 (ADD-114 D-4): which paths the provider gained, lost or retyped since the contract was
   * recorded. Present only when the binding recorded a `contract.shape`, that shape is
   * consistent with its own fingerprint (D-3), and something actually moved.
   *
   * NARRATIVE ONLY. `status` above is derived exactly as ADD-18 D-4 defines it, from the
   * fingerprint alone — this field explains a status it never determines (D-2). It rides into
   * `archstone verify --json` for free, since the CLI serialises this object directly.
   */
  drift?: ShapeDiff;
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

/**
 * Turn a fingerprint mismatch into a sentence that names what moved — or explains why it
 * cannot (ADD-114 D-3).
 *
 * Three outcomes, in order of how much we are entitled to claim:
 *   1. no `contract.shape` recorded → ADD-18's original wording, unchanged;
 *   2. a shape recorded that disagrees with its own fingerprint → say so, and name nothing. The
 *      two are records of one observation and can only diverge by hand-editing; naming fields
 *      from a shape that does not describe this contract is worse than naming none;
 *   3. a consistent shape → the named diff.
 */
function narrateShapeChange(
  contract: IRContract,
  liveShape: ShapeMap,
  liveFingerprint: string,
): { detail: string; drift?: ShapeDiff } {
  const fingerprints = `fingerprint ${contract.fingerprint} → ${liveFingerprint}`;
  if (!contract.shape) return { detail: `response shape changed (${fingerprints})` };
  if (fingerprintShapeMap(contract.shape) !== contract.fingerprint) {
    return { detail: `response shape changed (${fingerprints}); recorded shape is stale and was not used — re-record this contract` };
  }
  const drift = diffShape(contract.shape, liveShape);
  if (!hasShapeDrift(drift)) return { detail: `response shape changed (${fingerprints})` };
  return { detail: `response shape ${shapeDriftSummary(drift)}`, drift };
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
  // `callTool`/`executeCapability`, `verifyTool` itself does not read
  // `registry.getExposure(tool.id)` and still probes a `lifecycle: retired` capability exactly
  // like a `stable` one IF it is called directly on one. Two reasons, both load-bearing. (1)
  // `verifyTool` never emits an `Execution` audit record under any outcome, so the
  // manufactured-evidence harm ADD-51 exists to close is structurally impossible on this path
  // regardless of lifecycle wiring. (2) Gating `verifyTool` itself would make it impossible to
  // ever probe a retired capability on purpose (e.g. investigating one before un-retiring it).
  //
  // #54 (R-2's fix, once filed): the CI-release-gate regression this residual risk named — a
  // retired-but-still-`contract:`-bearing capability turning `archstone verify`'s gate red
  // forever — is fixed one level up, in `runVerify`'s contract-bearing filter (below), which
  // now excludes a non-invocable (retired) tool before it ever reaches this function. See
  // `runVerify`'s doc comment. This function is unchanged by that fix and remains reachable
  // directly on a retired tool by a caller who wants to probe one deliberately.
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
  const liveShape = describeShape(result.data);

  if (!tool.response) {
    // No response mapping to validate against — fingerprint drift is all we can see.
    if (!fingerprintChanged) return { ...base, status: "green", detail: "fingerprint unchanged" };
    const { detail, drift } = narrateShapeChange(contract, liveShape, liveFingerprint);
    return { ...base, status: "yellow", detail, ...(drift ? { drift } : {}) };
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
    const { detail, drift } = narrateShapeChange(contract, liveShape, liveFingerprint);
    return { ...base, status: "yellow", detail: `mapping still resolves; ${detail}`, ...(drift ? { drift } : {}) };
  }
  return { ...base, status: "green", detail: "fingerprint unchanged, mapping OK" };
}

/**
 * Verify every contract-bearing tool in a registry.
 *
 * #54 (fixing ADD-51 D-6's named residual risk, R-2): a `lifecycle: retired` capability is
 * excluded from the contract-bearing filter here — never handed to `verifyTool` at all, so it
 * never enters the returned report. This is deliberately NOT the same fix as `policyDenied`
 * (ADD-43 D-14): a policy denial still enters the report (marked, then skipped only by the
 * health-snapshot reader, `registry.ts`'s `readHealthSnapshot`) because a policy evaluation is
 * itself a fact worth reporting. A retirement is not — a business withdrawing a capability is a
 * normal operational event, not a thing `archstone verify` has anything to say about, so the
 * capability is simply never probed and never appears, exactly as if its `contract:` block did
 * not exist. That is what keeps `reports.some(r => r.status === "red")` (`cli/src/index.ts`,
 * the CI release gate) from going permanently red the day a `contract:`-bearing capability is
 * retired without also deleting its contract block.
 *
 * Invocability is read via `lifecycleExposure` — the exact pure lowering
 * `Registry.getExposure` (`@archstone/emitter-support/registry.ts`) composes into its
 * `exposureById` map, reused verbatim rather than re-deriving `lifecycle === "retired"` here
 * (ADD-24 D-6/R-5: any future reader shares this one computation). `runVerify` receives raw
 * `IRTool[]`, not a `Registry`, and health never affects `invocable` (ADD-24 D-9), so calling
 * `lifecycleExposure` directly — the same function `getExposure` calls, with no health
 * component to compose — yields an identical answer to `registry.getExposure(t.id).invocable`
 * for every tool.
 *
 * This does NOT change `verifyTool` itself (still deliberately ungated per D-6, directly
 * reachable and still probing a retired capability if called on one on purpose) — only this
 * orchestrator, which is what `archstone verify`/the CLI gate actually walks.
 *
 * `policyDenied` entries' gate handling is unchanged and explicitly out of scope for this fix
 * (see #54's PR description) — a separate decision, deferred.
 *
 * Bug fix (found reviewing #54): the original filter excluded every `invocable:false` tool —
 * `lifecycleExposure(...).invocable` is `false` for BOTH `lifecycle: "retired"` (this fix's
 * actual target) AND the `unevaluatable`/default branch (an unrecognized `lifecycle` value on a
 * hand-written or forward-versioned IR, ADD-56). That conflated a governance refusal with a
 * compatibility refusal: a capability with a corrupted/unrecognized lifecycle AND a genuinely
 * broken `contract:` block was silently excluded from the report instead of being probed and
 * flagged red — undermining ADD-56's "make incompatibility loud" goal on this one path. The
 * filter now checks `blockedReason !== "retired"` specifically, so an unrecognized-lifecycle
 * tool (`blockedReason: "unevaluatable"`) stays in `contractBearing` and is probed by
 * `verifyTool` exactly as it was before this whole feature shipped. `Exposure.blockedReason` is
 * always present when `invocable:false` and always absent when `invocable:true` (`exposure.ts`),
 * so this substitution needs no separate `invocable` check.
 */
export async function runVerify(
  tools: IRTool[],
  dir: string,
  resources: IRResourceRegistry,
  opts?: InvokeOptions,
): Promise<ToolVerification[]> {
  const contractBearing = tools.filter((t) => t.contract && lifecycleExposure(t.lifecycle).blockedReason !== "retired");
  return Promise.all(contractBearing.map((t) => verifyTool(t, dir, resources, opts)));
}

// ---------------------------------------------------------------------------------------
// Recording a contract (ADD-37 D-6 / R-1)
// ---------------------------------------------------------------------------------------

/**
 * How a probe ended.
 *
 * `green` / `yellow` / `red` mirror `HealthStatus` deliberately — this is the same question
 * `verifyTool` answers, asked one moment earlier. `not-attempted` is the fourth outcome
 * ADD-37 Amendment 1 §A-5 adds, and it is not a nicety:
 *
 * `invokeRest` returns `{ok: false, status: 0, error: "missing env var(s): …"}` BEFORE it
 * sends anything. Reporting that as `red` asserts that the backend disagreed with the
 * manifest, which is false — nothing was asked of the backend at all. False reds are how
 * people learn to ignore reds, and this one would fire on the very first run of every
 * generated manifest whose credential variable is not set yet.
 *
 * Same disposition as `red` for the CONTRACT (write nothing); the opposite disposition in the
 * report.
 */
export type ProbeOutcome = "green" | "yellow" | "red" | "not-attempted";

/**
 * The result of one recording attempt.
 *
 * `fingerprint` and `fixture` are present together or not at all — the schema requires
 * `source` + `fingerprint` + `probe.fixture`, so a half-recording is not a thing a caller
 * could write down even if it wanted to.
 */
export interface ContractRecording {
  capabilityId: string;
  outcome: ProbeOutcome;
  detail: string;
  fingerprint?: string;
  /** The recorded response shape (ADD-114 D-6), derived from the SAME body as `fingerprint`
   *  in the same call — which is what makes the two consistent by construction at the only
   *  point that writes them, and is what D-3's check later relies on. */
  shape?: ShapeMap;
  fixture?: GoldenFixture;
  /** Optional fields that came back absent or null. Real required/optional evidence — the
   *  caller may offer a loosening at the gate, and must never apply one silently: n=1 is not
   *  a classification. */
  degraded?: string[];
  /** Required fields that came back absent or null. A VIOLATION, and the reason nothing is
   *  written: a manifest that violates on its own recording is not a manifest. */
  missing?: string[];
}

export interface RecordContractOptions extends InvokeOptions {
  /** Injected so a test can pin the recorded timestamp. Defaults to the wall clock — this
   *  module is the runtime, not the pure core, and recording is inherently a moment in time. */
  now?: Date;
}

/** Errors `invokeRest` returns WITHOUT sending a request. Matched on the message because that
 *  is the only signal in the shipped return shape — `status: 0` alone also covers a network
 *  failure, which is a genuine red. */
const NOT_ATTEMPTED_RE = /^missing (?:env var|caller credential)\(s\):/;

/**
 * Record a contract for a tool that does not have one yet (ADD-37 D-6).
 *
 * A SIBLING of `verifyTool`, not a flag on it, and the reason is structural rather than
 * stylistic: `verifyTool` returns `red` on `!tool.contract` before doing anything, and the
 * contract is precisely what this function exists to create. The chicken-and-egg is real.
 *
 * What makes this the right place for it (R-1): it is the SAME module, over the SAME
 * `invokeRest` call, with the same policy evaluation and the same `fingerprintShape` and
 * `applyResponseMapping`, as the replay that will later be asked to trust the artifact. A
 * second orchestration of "call the backend, hash the shape, run the mapper" living in
 * `init` would look green at record time and be unreplayable afterwards — silently, for the
 * manifest's lifetime.
 *
 * It reads no filesystem: there is no fixture to find yet. That is the one deliberate
 * departure from ADD-37 §6 step 6's sketched `(tool, input, dir, resources, opts)` signature —
 * carrying a `dir` this function cannot use would suggest it does something with it.
 *
 * NOTE it never decides WHETHER to probe. Consent, the confirmed `effect: read` and the method
 * rule (R-8) are the caller's gate, upstream, where the human is.
 */
export async function recordContract(
  tool: IRTool,
  input: Record<string, unknown>,
  resources: IRResourceRegistry,
  opts?: RecordContractOptions,
): Promise<ContractRecording> {
  const base = { capabilityId: tool.id };

  // Same evaluation point as `verifyTool` (#43 / ADD-43 D-6), for the same reason: a probe
  // makes a real call with real credentials. `init` never emits `policies:`, so this cannot
  // fire on a freshly generated manifest — it is here so that re-recording an EXISTING
  // hand-written manifest cannot route around the gate.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    // `not-attempted`, not `red`.
    //
    // DELIBERATELY DIVERGENT FROM `verifyTool`, which answers `red` + `policyDenied` for this
    // identical condition — recorded here so nobody "fixes" the two into agreement. They are
    // answering different questions. `verifyTool` answers an OPERATOR's "is this binding
    // healthy?", and "I could not establish that" is honestly red (ADD-43 D-7); its
    // `policyDenied` flag then exists to stop that red travelling onward into an agent-facing
    // surface. `recordContract` answers "did I learn anything worth writing down?", and the
    // answer is simply no — nothing was asked of the backend. Both refuse to write a contract;
    // only the report wording differs, which is the whole point of the fourth outcome.
    return { ...base, outcome: "not-attempted", detail: `policy denied before any request was made: ${decision.denial.message}` };
  }

  const result = await invokeRest(tool, input, opts);
  if (!result.ok) {
    const error = result.error ?? `status ${result.status}`;
    if (result.status === 0 && NOT_ATTEMPTED_RE.test(error)) {
      return { ...base, outcome: "not-attempted", detail: `no request was sent — ${error}` };
    }
    return { ...base, outcome: "red", detail: `live request failed: ${error}` };
  }

  const fingerprint = fingerprintShape(result.data);
  const shape = describeShape(result.data);
  const fixture: GoldenFixture = {
    capabilityId: tool.id,
    recordedAt: (opts?.now ?? new Date()).toISOString(),
    request: input,
  };

  if (!tool.response) {
    // Nothing to validate against; the fingerprint is still a real, replayable fact.
    return { ...base, outcome: "green", detail: "recorded — no response mapping to validate", fingerprint, shape, fixture };
  }

  const mapped = applyResponseMapping(tool, result.data, resources);
  if (mapped.status === "violation") {
    // KEEP NOTHING. A field the manifest marks required came back null or absent on the very
    // response we are recording, so the contract would be green against a fiction and red
    // against reality. The loosening belongs at the gate, offered to a human, never applied
    // here: n=1 is not a classification.
    return {
      ...base,
      outcome: "red",
      detail: `contract violation on the recorded response: missing required field(s) ${(mapped.missing ?? []).join(", ")}`,
      ...(mapped.missing ? { missing: mapped.missing } : {}),
    };
  }
  if (mapped.status === "degraded") {
    return {
      ...base,
      outcome: "yellow",
      detail: `recorded, degraded: optional field(s) absent — ${(mapped.degraded ?? []).join(", ")}`,
      fingerprint,
      shape,
      fixture,
      ...(mapped.degraded ? { degraded: mapped.degraded } : {}),
    };
  }
  return { ...base, outcome: "green", detail: "recorded — mapping OK", fingerprint, shape, fixture };
}
