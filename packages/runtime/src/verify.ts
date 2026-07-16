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
import { applyResponseMapping } from "./mapping";

export type HealthStatus = "green" | "yellow" | "red";

export interface ToolVerification {
  capabilityId: string;
  status: HealthStatus;
  detail: string;
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
