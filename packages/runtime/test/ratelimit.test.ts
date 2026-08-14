import { describe, it, expect } from "vitest";
import type { IRTool, IR } from "@archstone/compiler";
import { Registry, InMemoryRateLimitCounter } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, POLICY_DENIED_META_KEY } from "../src/server";

// #45 (ADD-45) — `callTool`'s wiring of the rate-limit evaluation step, immediately after the
// policy evaluator (#43) and strictly before `invokeRest`. Mirrors policy.test.ts's discipline.

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

const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — a rate-limit denial performs no connector work whatsoever");
};

const okFetch: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });

const rateLimited = tool({ policyRules: [{ id: "rl", rateLimit: { maxInvocations: 2, windowSeconds: 60 } }] });

describe("callTool — the no-store default (fail-closed, #45 DoD)", () => {
  it("denies with policy_unevaluatable when rateLimit is declared and no counter is configured", async () => {
    const r = await callTool(registryOf(rateLimited), "bank.list", {}, { fetchImpl: forbiddenFetch });
    expect(r.isError).toBe(true);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "bank.list",
      reason: "policy_unevaluatable",
    });
  });
});

describe("callTool — exceeding the limit denies with the shared policy_denied shape (#45 DoD)", () => {
  it("allows up to maxInvocations, then denies with rate_limit_exceeded", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const registry = registryOf(rateLimited);

    const r1 = await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, rateLimitCounter: counter });
    expect(r1.isError).toBe(false);
    const r2 = await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, rateLimitCounter: counter });
    expect(r2.isError).toBe(false);

    const r3 = await callTool(registry, "bank.list", {}, { fetchImpl: forbiddenFetch, rateLimitCounter: counter });
    expect(r3.isError).toBe(true);
    expect(r3._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "bank.list",
      reason: "rate_limit_exceeded",
    });
  });

  it("issues ZERO outbound requests on the denying call (no backend call on denial)", async () => {
    let calls = 0;
    const countingFetch: FetchLike = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const counter = new InMemoryRateLimitCounter(() => 0);
    const registry = registryOf(rateLimited);
    await callTool(registry, "bank.list", {}, { fetchImpl: countingFetch, rateLimitCounter: counter });
    await callTool(registry, "bank.list", {}, { fetchImpl: countingFetch, rateLimitCounter: counter });
    expect(calls).toBe(2);
    await callTool(registry, "bank.list", {}, { fetchImpl: countingFetch, rateLimitCounter: counter });
    expect(calls).toBe(2); // the third (denied) call never reached fetch
  });

  it("keys by principal — a different caller has an independent bucket", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const registry = registryOf(rateLimited);
    await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, rateLimitCounter: counter, caller: { principal: "user:alice" } });
    await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, rateLimitCounter: counter, caller: { principal: "user:alice" } });
    const aliceThird = await callTool(registry, "bank.list", {}, {
      fetchImpl: forbiddenFetch,
      rateLimitCounter: counter,
      caller: { principal: "user:alice" },
    });
    expect(aliceThird.isError).toBe(true);

    const bobFirst = await callTool(registry, "bank.list", {}, {
      fetchImpl: okFetch,
      rateLimitCounter: counter,
      caller: { principal: "user:bob" },
    });
    expect(bobFirst.isError).toBe(false);
  });
});

describe("callTool — negative control: a capability WITHOUT rateLimit is entirely unaffected (#45 DoD)", () => {
  it("succeeds repeatedly with no counter configured at all", async () => {
    const plain = tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] });
    const registry = registryOf(plain);
    for (let i = 0; i < 5; i++) {
      const r = await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, caller: { principal: "user:alice" } });
      expect(r.isError).toBe(false);
    }
  });

  it("a tool with no policyRules at all is unaffected even with a counter configured", async () => {
    const plain = tool();
    const counter = new InMemoryRateLimitCounter(() => 0);
    const registry = registryOf(plain);
    for (let i = 0; i < 5; i++) {
      const r = await callTool(registry, "bank.list", {}, { fetchImpl: okFetch, rateLimitCounter: counter });
      expect(r.isError).toBe(false);
    }
  });
});

describe("callTool — order: policy denial takes precedence over rate limit (evaluatePolicy runs first)", () => {
  it("an unauthorized principal is denied by policy, never reaching the rate-limit step", async () => {
    const t = tool({
      policyRules: [
        { id: "allow-alice", allow: ["user:alice"] },
        { id: "rl", rateLimit: { maxInvocations: 100, windowSeconds: 60 } },
      ],
    });
    const r = await callTool(registryOf(t), "bank.list", {}, { fetchImpl: forbiddenFetch, caller: { principal: "user:mallory" } });
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "bank.list",
      reason: "principal_not_allowed",
    });
  });
});
