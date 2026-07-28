import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRTool, IR } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, toolDefinitions, POLICY_DENIED_META_KEY, LIFECYCLE_BLOCKED_META_KEY, CONTRACT_VIOLATION_META_KEY } from "../src/server";
import { runVerify, verifyTool } from "../src/verify";
import { buildRegistry, HEALTH_SNAPSHOT_FILE } from "../src/registry";

// #43 (ADD-43 D-6/D-7/D-14) — the runtime's two consumers of the one evaluation point:
// `callTool` (the MCP rendering of a refusal) and `verifyTool` (the contract prober, the third
// consumer neither #43's DoD nor ADD-42 §8.3 originally named).

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "bank.list",
    description: "List accounts.",
    effect: "read",
    provider: "core",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/accounts" } },
    ...over,
  };
}

function registryOf(...tools: IRTool[]): Registry {
  const ir: IR = { version: "0", company: { id: "acme" }, tools, resources: {} };
  return new Registry(ir);
}

/** A fetch that fails the test if it is ever reached — BR-25's "zero connector work". */
const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — a denial performs no connector work whatsoever");
};

const allowAlice = { id: "p", allow: ["user:alice"] };

describe("callTool — the structured MCP refusal (SF-4, BR-26…BR-30)", () => {
  it("carries policy_denied on _meta, with isError and no structuredContent (S-US3.1)", async () => {
    const r = await callTool(registryOf(tool({ policyRules: [allowAlice] })), "bank.list", {}, {
      fetchImpl: forbiddenFetch,
      caller: { principal: "user:mallory" },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(typeof r.content[0].text).toBe("string");
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "bank.list", // the unsanitized CDL id, never the sanitized advertised name
      reason: "principal_not_allowed",
    });
  });

  it("uses a key distinct from lifecycle_blocked and contract_violation (S-US3.3, BR-27)", async () => {
    expect(new Set([POLICY_DENIED_META_KEY, LIFECYCLE_BLOCKED_META_KEY, CONTRACT_VIOLATION_META_KEY]).size).toBe(3);
    const r = await callTool(registryOf(tool({ policyRules: [allowAlice] })), "bank.list", {}, {
      fetchImpl: forbiddenFetch,
    });
    expect(Object.keys(r._meta ?? {})).toEqual([POLICY_DENIED_META_KEY]);
  });

  it("discloses nothing about the policy to the client (S-US3.4, BR-30, Rule #7)", async () => {
    const r = await callTool(
      registryOf(tool({ policyRules: [{ id: "treasury-only", allow: ["user:alice", "role:treasury"] }] })),
      "bank.list",
      {},
      { fetchImpl: forbiddenFetch, caller: { principal: "user:mallory" } },
    );
    const serialized = JSON.stringify(r);
    for (const secret of ["treasury-only", "user:alice", "role:treasury"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("issues zero outbound requests on a denial (BR-25, #43 DoD)", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    await callTool(registryOf(tool({ policyRules: [allowAlice] })), "bank.list", {}, { fetchImpl });
    expect(calls).toBe(0);
  });

  // S-US4.6 / EC-16 — the denial short-circuits BEFORE env/caller resolution, so it is the
  // denial the caller sees, not a downstream "missing env var(s)" that masks it. The
  // `onResponse` hook must not fire either: no round-trip completed (#39 BR-4).
  it("wins over missing env/caller placeholders, and fires no onResponse hook (S-US4.6, EC-16)", async () => {
    let hookFired = false;
    const unresolvable = tool({
      policyRules: [allowAlice],
      connector: {
        type: "rest",
        rest: {
          baseUrl: "${NEVER_SET}",
          method: "GET",
          path: "/accounts",
          headers: { Authorization: "Bearer ${caller.accessToken}" },
        },
      },
    });
    const r = await callTool(registryOf(unresolvable), "bank.list", {}, {
      env: {},
      fetchImpl: forbiddenFetch,
      onResponse: () => {
        hookFired = true;
      },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toMatch(/missing env var/);
    expect(r.content[0].text).not.toMatch(/missing caller credential/);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toBeDefined();
    expect(hookFired).toBe(false);
  });

  it("allows a permitted principal through to the backend, with an unchanged result shape (S-US3.6)", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    const policed = await callTool(registryOf(tool({ policyRules: [allowAlice] })), "bank.list", {}, {
      fetchImpl,
      caller: { principal: "user:alice" },
    });
    const unpoliced = await callTool(registryOf(tool()), "bank.list", {}, { fetchImpl });
    // Byte-for-byte identical to the same invocation with no policy document present at all —
    // no _meta key, no extra field. This is the non-breaking guarantee, asserted rather than
    // assumed (BR-14/BR-44).
    expect(policed).toEqual(unpoliced);
    expect(policed._meta).toBeUndefined();
  });
});

describe("callTool — ordering and listing (BR-34, BR-36)", () => {
  // S-US8.5: without a pinned order the same call could return either refusal depending on
  // refactoring, and a retired capability would start reporting a policy problem it does not have.
  it("a retired capability reports lifecycle_blocked, never policy_denied (S-US8.5)", async () => {
    const r = await callTool(
      registryOf(tool({ lifecycle: "retired", policyRules: [allowAlice] })),
      "bank.list",
      {},
      { fetchImpl: forbiddenFetch },
    );
    expect(r._meta?.[LIFECYCLE_BLOCKED_META_KEY]).toBeDefined();
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toBeUndefined();
  });

  // BR-36 / Rule #6: caller-dependent discovery is a different feature nobody asked for, and
  // making it a side effect of #43 is exactly the creep ADD-24 was sequenced to avoid.
  it("policy does not affect tool listing at all (S-US8.4)", () => {
    const policed = toolDefinitions(registryOf(tool({ policyRules: [allowAlice] })));
    const unpoliced = toolDefinitions(registryOf(tool()));
    expect(policed).toEqual(unpoliced);
  });
});

describe("callTool — `authenticated` after the move (US-5)", () => {
  it("preserves the shipped text and adds the structured reason (S-US5.1/S-US5.2)", async () => {
    const r = await callTool(registryOf(tool({ policies: ["authenticated"] })), "bank.list", {}, {
      fetchImpl: forbiddenFetch,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/requires policies:\[authenticated\]/);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "bank.list",
      reason: "authenticated_no_credential",
    });
  });

  // S-US7.3 / BR-39: tenant scoping is a third axis, refused deliberately. Nothing this
  // increment adds may read `caller.tenantId`.
  it("does not enforce tenant-scoped and never reads caller.tenantId (S-US7.3)", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const r = await callTool(
      registryOf(tool({ policies: ["authenticated", "tenant-scoped"] })),
      "bank.list",
      {},
      { fetchImpl, caller: { accessToken: "t", tenantId: "tenant-a" } },
    );
    expect(r.isError).toBe(false);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// US-9 — the contract prober, the THIRD consumer (ADD-43 D-6). It is `authenticated`-gated
// today only because that check lived inside `invokeRest`; the move would have silently
// un-gated `archstone verify` and the published `runVerify()` without this wiring.

function contractManifest(dir: string, opts: { policy?: string; policies?: string[] } = {}): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    "company:\n  id: demo\ncapabilities:\n  - demo.probe\nproviders:\n  - acme\n",
  );
  writeFileSync(
    join(dir, "demo.probe.capability.yaml"),
    [
      "capability:",
      "  id: demo.probe",
      "  description: A probed capability.",
      "  effect: read",
      "  provider: acme",
      ...(opts.policies?.length ? ["  policies:", ...opts.policies.map((p) => `    - ${p}`)] : []),
      "  output:",
      "    value:",
      "      type: string",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "bindings"), { recursive: true });
  writeFileSync(
    join(dir, "bindings", "demo.probe.binding.yaml"),
    [
      "binding:",
      "  capabilityId: demo.probe",
      "  connector:",
      "    type: rest",
      "    rest:",
      '      baseUrl: "https://backend.example"',
      "      method: GET",
      "      path: /probe",
      "  contract:",
      "    source: recorded",
      `    fingerprint: "sha256:${"0".repeat(64)}"`,
      "    probe:",
      "      fixture: fixtures/demo.probe.golden.json",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(
    join(dir, "fixtures", "demo.probe.golden.json"),
    JSON.stringify({ capabilityId: "demo.probe", request: {} }),
  );
  if (opts.policy) writeFileSync(join(dir, "demo.policy.yaml"), opts.policy);
}

const PROBER_ONLY = [
  "apiVersion: archstone/v1",
  "kind: Policy",
  "metadata:",
  "  id: prober-only",
  "  name: Prober only",
  "  scope: capability",
  "  capabilityId: demo.probe",
  "spec:",
  "  allow:",
  '    - "service:prober"',
  "",
].join("\n");

/** AWAITS `fn` before cleaning up — a synchronous `finally` here would delete the manifest out
 *  from under an in-flight `runVerify`, which reads the golden fixture from disk. */
async function withManifest<T>(
  opts: Parameters<typeof contractManifest>[1],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "archstone-verify-policy-"));
  contractManifest(dir, opts);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("verifyTool — the third consumer (US-9, BR-37)", () => {
  it("denies a caller-less probe of an allow-gated capability, with zero fetches (S-US9.1)", async () => {
    const reports = await withManifest({ policy: PROBER_ONLY }, async (dir) => {
      const registry = buildRegistry(dir).registry!;
      return runVerify(registry.listCapabilities(), dir, registry.ir.resources, { fetchImpl: forbiddenFetch });
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe("red");
    expect(reports[0].detail).toMatch(/policy denied/);
  });

  // S-US9.2 — `live request failed:` is the prefix reserved for a request that was actually
  // made. No request was made here, so the detail must not claim one.
  it("its detail is distinguishable from a live-request failure (S-US9.2)", async () => {
    const report = await withManifest({ policy: PROBER_ONLY }, async (dir) => {
      const registry = buildRegistry(dir).registry!;
      return verifyTool(registry.listCapabilities()[0], dir, registry.ir.resources, { fetchImpl: forbiddenFetch });
    });
    expect(report.detail.startsWith("live request failed:")).toBe(false);
  });

  it("preserves today's `authenticated` behaviour: caller-less verify is still red (S-US9.3)", async () => {
    const report = await withManifest({ policies: ["authenticated"] }, async (dir) => {
      const registry = buildRegistry(dir).registry!;
      return verifyTool(registry.listCapabilities()[0], dir, registry.ir.resources, { fetchImpl: forbiddenFetch });
    });
    expect(report.status).toBe("red");
    expect(report.detail).toMatch(/requires policies:\[authenticated\]/);
  });

  it("a caller supplied to runVerify satisfies the policy and the fixture is replayed (S-US9.4)", async () => {
    let called = 0;
    const fetchImpl: FetchLike = async () => {
      called += 1;
      return new Response(JSON.stringify({ value: "ok" }), { status: 200 });
    };
    const reports = await withManifest({ policy: PROBER_ONLY }, async (dir) => {
      const registry = buildRegistry(dir).registry!;
      return runVerify(registry.listCapabilities(), dir, registry.ir.resources, {
        fetchImpl,
        caller: { principal: "service:prober", accessToken: "t" },
      });
    });
    expect(called).toBe(1);
    expect(reports[0].status).not.toBe("red");
    expect(reports[0].policyDenied).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// STEP 6b (ADD-43 D-14 / AC-8) — a refusal that happened before the call is not a health fact.
//
// This is the only rule in the increment whose violation is entirely SILENT: nothing throws, no
// exit code changes, no test elsewhere goes red. An agent simply reads
// "binding health: red — the last contract verification failed" on a capability whose contract
// was never checked — a false statement, at the highest hint severity, shown to every caller
// including permitted ones, which also makes policy affect listing (BR-36 forbids that). And
// because the CLI supplies no caller, it is the DEFAULT outcome for any allow-bearing
// capability, not a corner case.

describe("health snapshot — an evaluator denial never becomes a listing hint (ADD-43 D-14)", () => {
  it("leaves the advertised description byte-for-byte unchanged from the no-snapshot case", async () => {
    await withManifest({ policy: PROBER_ONLY }, async (dir) => {
      const baseline = toolDefinitions(buildRegistry(dir).registry!);

      // Exactly the documented ADD-24 D-8 workflow: a caller-less `archstone verify --json`
      // redirected into the conventional snapshot file, then serve. Produced by the real
      // runVerify, not hand-written, so the whole chain is under test.
      const registry = buildRegistry(dir).registry!;
      const results = await runVerify(registry.listCapabilities(), dir, registry.ir.resources, {
        fetchImpl: forbiddenFetch,
      });
      expect(results[0].status).toBe("red"); // the operator-facing report IS red (D-7)
      expect(results[0].policyDenied).toBe(true);
      writeFileSync(join(dir, HEALTH_SNAPSHOT_FILE), JSON.stringify({ results }));

      const afterSnapshot = toolDefinitions(buildRegistry(dir).registry!);
      expect(afterSnapshot).toEqual(baseline);
      expect(afterSnapshot[0].description).not.toMatch(/binding health/);
    });
  });

  it("still honours a genuine red — only policy denials are skipped, not health readings", async () => {
    await withManifest({}, async (dir) => {
      // Same file, same shape, no `policyDenied` marker: this one MUST raise the hint, or the
      // skip above would be indistinguishable from silently disabling the snapshot entirely.
      writeFileSync(
        join(dir, HEALTH_SNAPSHOT_FILE),
        JSON.stringify({ results: [{ capabilityId: "demo.probe", status: "red", detail: "live request failed: boom" }] }),
      );
      expect(toolDefinitions(buildRegistry(dir).registry!)[0].description).toMatch(/binding health: red/);
    });
  });
});
