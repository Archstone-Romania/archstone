import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "@archstone/runtime";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR } from "../src/index";
import { mcpHandler } from "../src/mcp";

// #43 — the embedded consumer (`execute()`), plus the increment's headline acceptance proof:
// MCP and execute() deny IDENTICALLY for the same capability + principal (#43 DoD item 2).

const ALLOW_ALICE = [
  "apiVersion: archstone/v1",
  "kind: Policy",
  "metadata:",
  "  id: alice-only",
  "  name: Alice only",
  "  scope: capability",
  "  capabilityId: demo.read",
  "spec:",
  "  allow:",
  '    - "user:alice"',
  "",
].join("\n");

/** A minimal, bound, policy-gated manifest — the smallest thing that exercises the whole
 *  pipeline: load → semantic pass → compile → artifact → fromIR → both invocation paths. */
function writeManifest(dir: string, policy?: string): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    "company:\n  id: demo\ncapabilities:\n  - demo.read\nproviders:\n  - acme\n",
  );
  writeFileSync(
    join(dir, "demo.read.capability.yaml"),
    "capability:\n  id: demo.read\n  description: Read a thing.\n  effect: read\n  provider: acme\n",
  );
  mkdirSync(join(dir, "bindings"), { recursive: true });
  writeFileSync(
    join(dir, "bindings", "demo.read.binding.yaml"),
    [
      "binding:",
      "  capabilityId: demo.read",
      "  connector:",
      "    type: rest",
      "    rest:",
      '      baseUrl: "https://backend.example"',
      "      method: GET",
      "      path: /thing",
      "",
    ].join("\n"),
  );
  if (policy) writeFileSync(join(dir, "demo.policy.yaml"), policy);
}

/** The `archstone build` artifact is the IR round-tripped through JSON — simulate it exactly,
 *  so `policyRules` surviving serialization is part of what these tests prove. */
function artifact(policy?: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "archstone-agent-policy-"));
  try {
    writeManifest(dir, policy);
    const built = buildRegistry(dir);
    expect(built.ok).toBe(true);
    return JSON.parse(JSON.stringify(built.registry!.ir)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — a denial performs no connector work whatsoever");
};

const okFetch: FetchLike = async () => new Response(JSON.stringify({ value: "ok" }), { status: 200 });

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const callToolBody = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "demo_read", arguments: {} },
});

async function toolResult(res: Response): Promise<{
  isError?: boolean;
  content?: { text: string }[];
  _meta?: Record<string, { error?: string; capability?: string; reason?: string }>;
}> {
  const body = (await res.json()) as { result?: Awaited<ReturnType<typeof toolResult>> };
  return body.result ?? {};
}

describe("execute() — the embedded refusal (SF-5, BR-31 / ADD-43 D-11)", () => {
  it("returns status 'error' with an additive denial object (S-US3.5)", async () => {
    const archstone = fromIR(artifact(ALLOW_ALICE));
    const r = await archstone.execute("demo.read", {}, { fetchImpl: forbiddenFetch, caller: { principal: "user:bob" } });
    expect(r.status).toBe("error"); // no fifth status value — a published union stays intact
    expect(typeof r.error).toBe("string");
    expect(r.denial).toEqual({ reason: "principal_not_allowed", capability: "demo.read" });
  });

  it("leaves `denial` undefined on every non-denied outcome (additive and non-breaking)", async () => {
    const archstone = fromIR(artifact(ALLOW_ALICE));
    const ok = await archstone.execute("demo.read", {}, { fetchImpl: okFetch, caller: { principal: "user:alice" } });
    expect(ok.status).toBe("ok");
    expect(ok.denial).toBeUndefined();
    const unknown = await archstone.execute("nope", {}, { fetchImpl: okFetch });
    expect(unknown.status).toBe("error");
    expect(unknown.denial).toBeUndefined();
  });

  it("issues zero outbound requests on a denial", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    await fromIR(artifact(ALLOW_ALICE)).execute("demo.read", {}, { fetchImpl });
    expect(calls).toBe(0);
  });
});

describe("the built artifact carries policy — the embedded path is not unpoliced (S-US2.4, BR-8)", () => {
  // `archstone build` strips `contract`; `policyRules` must survive, or the embedded SDK runs
  // unpoliced beside a policed MCP surface — silently, since `fromIR` validates only `version`.
  it("policyRules survives the IR → JSON → fromIR round trip and denies", async () => {
    const built = artifact(ALLOW_ALICE);
    const tools = built.tools as { id: string; policyRules?: unknown }[];
    expect(tools[0].policyRules).toEqual([{ id: "alice-only", allow: ["user:alice"] }]);

    const r = await fromIR(built).execute("demo.read", {}, { fetchImpl: forbiddenFetch, caller: { principal: "user:bob" } });
    expect(r.denial?.reason).toBe("principal_not_allowed");
  });

  // EC-13 / S-US8.3 — a pre-#43 artifact carries no policy field and is accepted unchanged.
  it("still accepts an artifact with no policyRules at all (no version bump, ADD-43 D-10)", async () => {
    const built = artifact();
    expect(built.version).toBe("0");
    const r = await fromIR(built).execute("demo.read", {}, { fetchImpl: okFetch });
    expect(r.status).toBe("ok");
  });
});

describe("fail-closed on an artifact this version cannot evaluate (S-US4.4/4.5)", () => {
  it("denies with policy_unevaluatable rather than partially applying the rule", async () => {
    // A hand-constructed artifact — the path that bypasses `archstone apply` entirely, which is
    // exactly what BR-24 is defence in depth for. The `allow` entry below is SATISFIED.
    const built = artifact(ALLOW_ALICE);
    const tools = built.tools as { policyRules: Record<string, unknown>[] }[];
    tools[0].policyRules[0].constraints = { maxRefundAmount: 500 };

    const r = await fromIR(built).execute("demo.read", {}, { fetchImpl: forbiddenFetch, caller: { principal: "user:alice" } });
    expect(r.status).toBe("error");
    expect(r.denial?.reason).toBe("policy_unevaluatable");
  });
});

// ---------------------------------------------------------------------------------------
// #43 DoD item 2 — "a test proves MCP and @archstone/agent deny identically for the same
// capability + principal".
//
// ADD-43 §8.9 / BR-33 / ADD-42 D-13: identity reaches the MCP side through `resolveCaller` and
// NEVER through `invoke.caller`. `runtime/src/http.ts` rebuilds the per-request bag as
// `{ ...invoke, caller: resolveCaller?.(request) }` — the explicit key overwrites the spread —
// so a parity test wired through `invoke.caller` would fail closed, read as a policy denial,
// and "prove" parity while testing nothing. That exact false signal seeded ADD-42's original
// wrong premise and cost two rounds to unwind. S-US2.3 below asserts the inertness directly, so
// the suite catches a test wired the wrong way instead of passing falsely.

describe("cross-path parity: MCP and execute() decide identically (US-2)", () => {
  const auth = { authorization: "Bearer endpoint-secret" };

  it("both DENY the same principal, with the same reason, message and zero fetches (S-US2.1)", async () => {
    const built = artifact(ALLOW_ALICE);

    const embedded = await fromIR(built).execute("demo.read", {}, {
      fetchImpl: forbiddenFetch,
      caller: { principal: "user:bob" },
    });

    const handler = mcpHandler(fromIR(built), {
      bearerToken: "endpoint-secret",
      invoke: { fetchImpl: forbiddenFetch },
      resolveCaller: () => ({ principal: "user:bob" }),
    });
    const mcp = await toolResult(await handler(mcpRequest(callToolBody(1), auth)));

    expect(mcp.isError).toBe(true);
    expect(embedded.status).toBe("error");
    // Same decision, same reason code, same human message text. The ENVELOPES differ by
    // construction (`_meta` vs `ExecuteResult.denial`) and are deliberately not converged (BR-32).
    expect(mcp._meta?.["dev.archstone/policy_denied"]?.reason).toBe(embedded.denial?.reason);
    expect(mcp._meta?.["dev.archstone/policy_denied"]?.reason).toBe("principal_not_allowed");
    expect(mcp._meta?.["dev.archstone/policy_denied"]?.capability).toBe(embedded.denial?.capability);
    expect(mcp.content?.[0]?.text).toBe(embedded.error);
  });

  it("both ALLOW a permitted principal and reach the backend exactly once each (S-US2.2)", async () => {
    const built = artifact(ALLOW_ALICE);
    let calls = 0;
    const counting: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ value: "ok" }), { status: 200 });
    };

    const embedded = await fromIR(built).execute("demo.read", {}, { fetchImpl: counting, caller: { principal: "user:alice" } });
    expect(embedded.status).toBe("ok");
    expect(calls).toBe(1);

    const handler = mcpHandler(fromIR(built), {
      bearerToken: "endpoint-secret",
      invoke: { fetchImpl: counting },
      resolveCaller: () => ({ principal: "user:alice" }),
    });
    const mcp = await toolResult(await handler(mcpRequest(callToolBody(1), auth)));
    expect(mcp.isError).toBeFalsy();
    expect(calls).toBe(2);
  });

  // S-US2.3 — the trap, asserted as a positive criterion rather than left as a footnote.
  it("a static invoke.caller is INERT on the MCP path, so a test wired through it is a false pass (S-US2.3)", async () => {
    const handler = mcpHandler(fromIR(artifact(ALLOW_ALICE)), {
      bearerToken: "endpoint-secret",
      invoke: { fetchImpl: forbiddenFetch, caller: { principal: "user:alice" } }, // would be ALLOWED
      // deliberately no resolveCaller — http.ts:66's explicit `caller` key overwrites the spread
    });
    const mcp = await toolResult(await handler(mcpRequest(callToolBody(1), auth)));
    expect(mcp.isError).toBe(true);
    expect(mcp._meta?.["dev.archstone/policy_denied"]?.reason).toBe("principal_not_allowed");
  });

  it("tools/list is identical with and without a policy (BR-36, S-US8.4)", async () => {
    const listOf = async (policy?: string): Promise<unknown> => {
      const handler = mcpHandler(fromIR(artifact(policy)), {
        bearerToken: "endpoint-secret",
        invoke: { fetchImpl: forbiddenFetch },
        resolveCaller: () => ({ principal: "user:bob" }), // a caller the policy would DENY
      });
      await handler(mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } } }, auth));
      const res = await handler(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth));
      return ((await res.json()) as { result?: { tools?: unknown } }).result?.tools;
    };
    expect(await listOf(ALLOW_ALICE)).toEqual(await listOf());
  });

  it("tools() on the embedded SDK is likewise unaffected by policy (BR-36)", () => {
    expect(fromIR(artifact(ALLOW_ALICE)).tools("anthropic")).toEqual(fromIR(artifact()).tools("anthropic"));
  });
});
