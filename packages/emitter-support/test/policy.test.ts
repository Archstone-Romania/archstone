import { describe, it, expect } from "vitest";
import type { IRTool, IRPolicyRule } from "@archstone/compiler";
import { evaluatePolicy, type PolicyDecision } from "../src/policy";

// #43 / ADD-43 §8.5 — the one evaluation point, unit-tested in isolation. Every rule the three
// consumers rely on is pinned here once; the consumer tests then prove routing, not semantics.

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "banking.list-accounts",
    description: "List accounts.",
    effect: "read",
    provider: "core-banking",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    ...over,
  };
}

const anonymous = { credentialPresent: false } as const;

function reasonOf(d: PolicyDecision): string | undefined {
  return d.allowed ? undefined : d.denial.reason;
}

describe("evaluatePolicy — the non-breaking guarantee (BR-14)", () => {
  it("allows a capability with no policy tokens and no resolved policy documents", () => {
    expect(evaluatePolicy(tool(), anonymous)).toEqual({ allowed: true });
  });

  it("allows when policyRules is present but empty", () => {
    expect(evaluatePolicy(tool({ policyRules: [] }), anonymous).allowed).toBe(true);
  });
});

describe("evaluatePolicy — the `authenticated` token (BR-19, ADD-42 D-7)", () => {
  const authed = tool({ policies: ["authenticated"] });

  it("preserves the shipped message byte-for-byte", () => {
    const d = evaluatePolicy(authed, anonymous);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.denial.message).toBe(
      "capability 'banking.list-accounts' requires policies:[authenticated] — no caller credential (accessToken) provided on invoke",
    );
    expect(reasonOf(d)).toBe("authenticated_no_credential");
  });

  // ADD-42 D-7's four-way matrix (S-US5.3) — the highest-probability misreading of that ADD:
  // `authenticated` means "a caller CREDENTIAL was supplied", never "a principal was resolved".
  it("denies exactly the two no-credential rows of the {credential} × {principal} matrix", () => {
    const rows: { credentialPresent: boolean; principal?: string; allowed: boolean }[] = [
      { credentialPresent: false, principal: undefined, allowed: false },
      { credentialPresent: false, principal: "user:alice", allowed: false },
      { credentialPresent: true, principal: undefined, allowed: true },
      { credentialPresent: true, principal: "user:alice", allowed: true },
    ];
    for (const row of rows) {
      const d = evaluatePolicy(authed, { credentialPresent: row.credentialPresent, principal: row.principal });
      expect({ ...row, allowed: d.allowed }).toEqual(row);
      if (!d.allowed) expect(d.denial.reason).toBe("authenticated_no_credential");
    }
  });

  it("a principal alone does not satisfy it (S-US5.4)", () => {
    const d = evaluatePolicy(authed, { credentialPresent: false, principal: "user:alice" });
    expect(reasonOf(d)).toBe("authenticated_no_credential");
  });

  it('treats an explicit "" credential as PRESENT — the shipped resolveEnv/resolveCaller rule', () => {
    // The call site computes `accessToken !== undefined`; "" is a deliberate value, not absence.
    expect(evaluatePolicy(authed, { credentialPresent: true }).allowed).toBe(true);
  });
});

describe("evaluatePolicy — pattern grammar (BR-9…BR-13, resolves ADD-42 OQ-2)", () => {
  const allowAlice = tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] });

  it("matches exactly and case-sensitively (S-US6.1)", () => {
    const cased = tool({ policyRules: [{ id: "p", allow: ["user:Alice"] }] });
    expect(evaluatePolicy(cased, { credentialPresent: true, principal: "user:alice" }).allowed).toBe(false);
    expect(evaluatePolicy(cased, { credentialPresent: true, principal: "user:Alice" }).allowed).toBe(true);
  });

  it("does not prefix- or substring-match (S-US6.2)", () => {
    const d = evaluatePolicy(allowAlice, { credentialPresent: true, principal: "user:alice-admin" });
    expect(reasonOf(d)).toBe("principal_not_allowed");
  });

  it("does not trim or normalize an opaque principal (EC-17)", () => {
    expect(evaluatePolicy(allowAlice, { credentialPresent: true, principal: " user:alice" }).allowed).toBe(false);
    expect(evaluatePolicy(allowAlice, { credentialPresent: true, principal: "user:alice\n" }).allowed).toBe(false);
  });

  it("an ABSENT principal satisfies no allow entry (S-US6.6, BR-12/BR-16)", () => {
    expect(reasonOf(evaluatePolicy(allowAlice, anonymous))).toBe("principal_not_allowed");
  });

  it('an EMPTY-STRING principal is present, and therefore simply matches nothing (S-US6.9, BR-13)', () => {
    expect(reasonOf(evaluatePolicy(allowAlice, { credentialPresent: true, principal: "" }))).toBe(
      "principal_not_allowed",
    );
  });

  it("deny wins over allow for the same principal (S-US6.7, BR-15)", () => {
    const both = tool({ policyRules: [{ id: "p", allow: ["user:alice"], deny: ["user:alice"] }] });
    expect(reasonOf(evaluatePolicy(both, { credentialPresent: true, principal: "user:alice" }))).toBe(
      "principal_denied",
    );
  });

  it("a deny-only policy ALLOWS an anonymous caller — the footgun BR-17 warns about", () => {
    const denyOnly = tool({ policyRules: [{ id: "p", deny: ["user:mallory"] }] });
    expect(evaluatePolicy(denyOnly, anonymous).allowed).toBe(true);
    expect(reasonOf(evaluatePolicy(denyOnly, { credentialPresent: true, principal: "user:mallory" }))).toBe(
      "principal_denied",
    );
  });
});

describe("evaluatePolicy — composition across policies (BR-6 / ADD-43 D-13)", () => {
  // Intersection on allow, union on deny. Intersection is the SAFE direction: union would let a
  // capability-scoped policy silently widen access beyond its provider-scoped baseline.
  const twoAllows = tool({
    policyRules: [
      { id: "provider-wide", allow: ["user:alice", "user:bob"] },
      { id: "capability-scoped", allow: ["user:bob"] },
    ],
  });

  it("requires EVERY non-empty allow to be satisfied — intersection, not union (S-US1.9)", () => {
    expect(evaluatePolicy(twoAllows, { credentialPresent: true, principal: "user:bob" }).allowed).toBe(true);
    expect(reasonOf(evaluatePolicy(twoAllows, { credentialPresent: true, principal: "user:alice" }))).toBe(
      "principal_not_allowed",
    );
  });

  it("disjoint allow sets make the capability invocable by nobody (EC-4)", () => {
    const disjoint = tool({
      policyRules: [
        { id: "a", allow: ["user:alice"] },
        { id: "b", allow: ["user:bob"] },
      ],
    });
    for (const principal of ["user:alice", "user:bob"]) {
      expect(evaluatePolicy(disjoint, { credentialPresent: true, principal }).allowed).toBe(false);
    }
  });

  it("a deny in ANY policy denies — never first-match", () => {
    const mixed = tool({
      policyRules: [{ id: "a", allow: ["user:alice"] }, { id: "b", deny: ["user:alice"] }],
    });
    expect(reasonOf(evaluatePolicy(mixed, { credentialPresent: true, principal: "user:alice" }))).toBe(
      "principal_denied",
    );
  });

  it("a policy carrying no allow imposes no allow-list constraint of its own", () => {
    const one = tool({ policyRules: [{ id: "a", allow: ["user:alice"] }, { id: "b" }] });
    expect(evaluatePolicy(one, { credentialPresent: true, principal: "user:alice" }).allowed).toBe(true);
  });
});

describe("evaluatePolicy — fail-closed on anything unevaluatable (BR-24)", () => {
  // Unreachable from `archstone apply` (rateLimit/non-empty constraints are authoring errors and
  // an empty constraints is stripped at lowering) — this is defence in depth for the paths that
  // bypass apply entirely: a hand-written archstone.ir.json, or a forward-versioned artifact.
  const withUnknownKey = (extra: Record<string, unknown>): IRTool =>
    tool({ policyRules: [{ id: "p", allow: ["user:alice"], ...extra } as unknown as IRPolicyRule] });

  it("denies with policy_unevaluatable on an unrecognized rule key", () => {
    const d = evaluatePolicy(withUnknownKey({ constraints: { maxRefundAmount: 500 } }), {
      credentialPresent: true,
      principal: "user:alice",
    });
    expect(reasonOf(d)).toBe("policy_unevaluatable");
  });

  it("is NEVER partially applied — a satisfied allow does not carry the decision (S-US4.5)", () => {
    // The principal is on the allow list and would otherwise proceed. It still denies.
    const d = evaluatePolicy(withUnknownKey({ rateLimit: { maxInvocations: 5 } }), {
      credentialPresent: true,
      principal: "user:alice",
    });
    expect(d.allowed).toBe(false);
    expect(reasonOf(d)).toBe("policy_unevaluatable");
  });

  it("runs FIRST — before the authenticated branch (BR-15 step 0 ordering)", () => {
    const t = withUnknownKey({ somethingNew: true });
    t.policies = ["authenticated"];
    // Both branches would deny; the order decides which reason a client sees, and an unpinned
    // order would let a refactor silently change the reason code an auditor filters on.
    expect(reasonOf(evaluatePolicy(t, anonymous))).toBe("policy_unevaluatable");
  });

  it("denies a malformed allow/deny (not an array of strings)", () => {
    const bad = tool({ policyRules: [{ id: "p", allow: "user:alice" } as unknown as IRPolicyRule] });
    expect(reasonOf(evaluatePolicy(bad, { credentialPresent: true, principal: "user:alice" }))).toBe(
      "policy_unevaluatable",
    );
    const bad2 = tool({ policyRules: [{ id: "p", deny: [1, 2] } as unknown as IRPolicyRule] });
    expect(reasonOf(evaluatePolicy(bad2, anonymous))).toBe("policy_unevaluatable");
  });

  it("denies when policyRules itself is not an array", () => {
    const bad = tool({ policyRules: { id: "p" } as unknown as IRPolicyRule[] });
    expect(reasonOf(evaluatePolicy(bad, anonymous))).toBe("policy_unevaluatable");
  });

  // The decision point must never THROW on malformed input. `fromIR` accepts an artifact on
  // `version === "0"` alone and treats the rest as opaque, so a hand-written or corrupted one
  // reaches this function with no `policies` at all — and an exception escaping here would
  // surface as a transport-level failure rather than a refusal, which is the ADD-42 R-11 family
  // of mistake ("identity/authorization could not be established" resolving to anything other
  // than a denial). `policyRules` was already hardened six ways; `policies` was not.
  it("denies rather than throwing when `policies` is absent or malformed", () => {
    for (const policies of [undefined, null, "authenticated", 7, [1, 2]]) {
      const bad = { ...tool(), policies } as unknown as IRTool;
      let decision: PolicyDecision | undefined;
      expect(() => {
        decision = evaluatePolicy(bad, { credentialPresent: true, principal: "user:alice" });
      }).not.toThrow();
      expect(decision && reasonOf(decision)).toBe("policy_unevaluatable");
    }
  });

  // The fail-closed direction matters specifically: an unreadable token list must not silently
  // resolve to "no tokens declared", which would un-enforce `authenticated` on exactly the
  // artifacts least worth trusting.
  it("does not treat an unreadable token list as 'no tokens declared'", () => {
    const bad = { ...tool(), policies: undefined } as unknown as IRTool;
    expect(evaluatePolicy(bad, { credentialPresent: true }).allowed).toBe(false);
  });
});

describe("evaluatePolicy — purity and disclosure", () => {
  it("is a pure function: no mutation, and identical arguments give identical results (S-US2.5)", () => {
    const t = tool({ policies: ["authenticated"], policyRules: [{ id: "p", allow: ["user:alice"] }] });
    const before = JSON.stringify(t);
    const first = evaluatePolicy(t, { credentialPresent: true, principal: "user:bob" });
    const second = evaluatePolicy(t, { credentialPresent: true, principal: "user:bob" });
    expect(first).toEqual(second);
    expect(JSON.stringify(t)).toBe(before);
  });

  // BR-30 / Rule #7: the MCP client is the untrusted side of the boundary. A message naming the
  // policy or echoing its entries turns the tool surface into an enumeration oracle.
  it("discloses no policy id and no allow/deny entry in the message (S-US3.4)", () => {
    const t = tool({ policyRules: [{ id: "treasury-only", allow: ["user:alice", "role:treasury"] }] });
    const d = evaluatePolicy(t, { credentialPresent: true, principal: "user:mallory" });
    const message = d.allowed ? "" : d.denial.message;
    for (const secret of ["treasury-only", "user:alice", "role:treasury"]) {
      expect(message).not.toContain(secret);
    }
  });

  // The deliberate non-distinction (BR-30, founder-confirmed): "you are anonymous" and "you are
  // the wrong principal" must be indistinguishable to the caller. Do not "improve" this.
  it("does not let an attacker distinguish anonymous from wrong-principal", () => {
    const t = tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] });
    const wrong = evaluatePolicy(t, { credentialPresent: true, principal: "user:mallory" });
    const absent = evaluatePolicy(t, { credentialPresent: true });
    expect(wrong).toEqual(absent);
  });
});
