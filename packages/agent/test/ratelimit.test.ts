import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { IR } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";
import { InMemoryRateLimitCounter } from "@archstone/emitter-support";
import { fromIR } from "../src/index";

// #45 (ADD-45) — `executeCapability`'s wiring of the SAME rate-limit evaluation step `callTool`
// uses, at the SAME point in the call sequence. Mirrors runtime/test/ratelimit.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const bank = resolve(here, "../../../examples/manifests/bank");

function artifact(dir: string): IR {
  return JSON.parse(JSON.stringify(buildRegistry(dir).registry!.ir)) as IR;
}

const ok200: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — a rate-limit denial performs no connector work whatsoever");
};

/** bank/banking.list-accounts, with any existing policyRules replaced by exactly one
 *  rateLimit-bearing rule — the smallest fixture that exercises the whole pipeline. */
function rateLimitedArtifact(maxInvocations: number, windowSeconds: number): IR {
  const ir = artifact(bank);
  const tool = ir.tools.find((t) => t.id === "banking.list-accounts")!;
  tool.policyRules = [{ id: "rl", rateLimit: { maxInvocations, windowSeconds } }];
  return ir;
}

describe("execute() — the no-store default (fail-closed, #45 DoD)", () => {
  it("denies with reason policy_unevaluatable when rateLimit is declared and no counter is configured", async () => {
    const a = fromIR(rateLimitedArtifact(2, 60));
    const r = await a.execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect(r.status).toBe("error");
    expect(r.denial).toEqual({ reason: "policy_unevaluatable", capability: "banking.list-accounts" });
  });
});

describe("execute() — exceeding the limit denies with the shared denial shape (#45 DoD)", () => {
  it("allows up to maxInvocations, then denies with rate_limit_exceeded, doing zero connector work on the denying call", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const a = fromIR(rateLimitedArtifact(2, 60));
    const opts = {
      env: { CORE_BANKING_URL: "https://core.example" },
      caller: { accessToken: "caller-token-7d1e" },
      rateLimitCounter: counter,
    };

    const r1 = await a.execute("banking.list-accounts", {}, { ...opts, fetchImpl: ok200 });
    expect(r1.status).toBe("ok");
    const r2 = await a.execute("banking.list-accounts", {}, { ...opts, fetchImpl: ok200 });
    expect(r2.status).toBe("ok");

    const r3 = await a.execute("banking.list-accounts", {}, { ...opts, fetchImpl: forbiddenFetch });
    expect(r3.status).toBe("error");
    expect(r3.denial).toEqual({ reason: "rate_limit_exceeded", capability: "banking.list-accounts" });
  });
});

describe("execute() — negative control: a capability WITHOUT rateLimit is entirely unaffected (#45 DoD)", () => {
  it("succeeds repeatedly with no counter configured at all", async () => {
    const a = fromIR(artifact(bank));
    for (let i = 0; i < 3; i++) {
      const r = await a.execute("banking.list-accounts", {}, {
        env: { CORE_BANKING_URL: "https://core.example" },
        fetchImpl: ok200,
        caller: { accessToken: "caller-token-7d1e", principal: "user:alice" },
      });
      expect(r.status).toBe("ok");
    }
  });
});

describe("MCP and execute() deny IDENTICALLY for a rate-limited capability (parity, mirrors #43 DoD item 2)", () => {
  it("both surfaces return reason rate_limit_exceeded once the shared counter is exhausted", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const ir = rateLimitedArtifact(1, 60);
    const a = fromIR(ir);
    const opts = {
      env: { CORE_BANKING_URL: "https://core.example" },
      caller: { accessToken: "caller-token-7d1e" },
      rateLimitCounter: counter,
    };
    const first = await a.execute("banking.list-accounts", {}, { ...opts, fetchImpl: ok200 });
    expect(first.status).toBe("ok");
    const second = await a.execute("banking.list-accounts", {}, { ...opts, fetchImpl: forbiddenFetch });
    expect(second.denial?.reason).toBe("rate_limit_exceeded");
  });
});
