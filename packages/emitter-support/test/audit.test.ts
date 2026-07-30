import { describe, it, expect, vi } from "vitest";
import { validateExecution } from "@archstone/schema";
import type { IRTool } from "@archstone/compiler";
import {
  buildExecutionRecord,
  emitExecutionRecord,
  jsonLinesAuditSink,
  auditNow,
  REDACTED,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
  type AuditSink,
  type ExecutionRecord,
  type ExecutionDenialReason,
} from "../src/audit";
import { contractViolationMessage } from "../src/mapping";
import type { PolicyDenialReason } from "../src/policy";

// #44 (ADD-44) — the shared record builder, the fire-and-forget hand-off, and the reference
// JSON Lines sink. The two audited consumers' own emission is exercised where it lives
// (runtime/test/audit.test.ts, agent/test/audit.test.ts); this file pins the pieces they share.

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
    ...over,
  };
}

function record(over: Partial<Parameters<typeof buildExecutionRecord>[0]> = {}): ExecutionRecord {
  return buildExecutionRecord({
    tool: tool(),
    input: {},
    consumer: "mcp",
    startedAt: auditNow(),
    status: { phase: "succeeded" },
    ...over,
  });
}

describe("buildExecutionRecord — the record IS the schema (BR-7, S-US2.1…S-US2.3)", () => {
  it("validates against the COMPILED execution.schema.json on every terminal phase", () => {
    const cases: ExecutionRecord[] = [
      record({ status: { phase: "succeeded" } }),
      record({ status: { phase: "failed", message: "backend returned 503" } }),
      record({ status: { phase: "denied", message: "no", denialReason: "principal_not_allowed" } }),
      record({ status: { phase: "denied", message: "retired", denialReason: LIFECYCLE_BLOCKED_REASON } }),
    ];
    for (const r of cases) {
      const v = validateExecution(r);
      expect(v.errors).toBe("");
      expect(v.ok).toBe(true);
    }
  });

  it("rejects the removed in-flight phases 'pending'/'running' (ADD-44 D-12, #53)", () => {
    const r = record({ status: { phase: "succeeded" } });
    for (const phase of ["pending", "running"]) {
      const v = validateExecution({ ...r, status: { ...r.status, phase } });
      expect(v.ok).toBe(false);
      expect(v.errors).not.toBe("");
    }
  });

  it("carries apiVersion/kind constants and the unsanitized CDL id + provider (S-US2.3, S-US2.7)", () => {
    const r = record({ tool: tool({ id: "banking.list-accounts", provider: "core-banking" }) });
    expect(r.apiVersion).toBe("archstone/v1");
    expect(r.kind).toBe("Execution");
    expect(r.metadata.capabilityId).toBe("banking.list-accounts"); // never "banking_list-accounts"
    expect(r.metadata.provider).toBe("core-banking");
  });

  it("takes completedAt at build time and never before startedAt (S-US2.5, BR-21)", () => {
    const startedAt = auditNow();
    const r = record({ startedAt });
    expect(r.metadata.startedAt).toBe(startedAt);
    expect(Date.parse(r.metadata.completedAt)).toBeGreaterThanOrEqual(Date.parse(startedAt));
    // The loader registers date-time as an always-true format for authoring placeholders, so
    // RFC-3339 well-formedness is asserted here rather than by the schema call above.
    for (const t of [r.metadata.startedAt, r.metadata.completedAt]) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("gives 1000 records built back-to-back 1000 distinct ids (BR-22, S-US2.6)", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => record().metadata.id));
    expect(ids.size).toBe(1000);
  });

  it("never derives the id from the capability id, the input, the principal or the timestamp", () => {
    const startedAt = auditNow();
    const a = record({ startedAt, input: { x: 1 }, caller: { principal: "user:alice" } });
    const b = record({ startedAt, input: { x: 1 }, caller: { principal: "user:alice" } });
    expect(a.metadata.id).not.toBe(b.metadata.id);
    for (const part of ["bank.list", "user:alice", startedAt]) {
      expect(a.metadata.id).not.toContain(part);
    }
  });
});

describe("buildExecutionRecord — principal presence is the disclosure seam (BR-10, BR-18)", () => {
  it("omits the key entirely when no principal was supplied — not null, not \"\", not \"anonymous\"", () => {
    const r = record({ caller: { accessToken: "caller-token-7d1e" } });
    expect("principal" in r.spec).toBe(false);
    expect(JSON.stringify(r)).not.toContain("anonymous");
  });

  it("records an EXPLICIT empty-string principal as present with the value \"\" (S-US3.10)", () => {
    const r = record({ caller: { principal: "" } });
    expect("principal" in r.spec).toBe(true);
    expect(r.spec.principal).toBe("");
    expect(validateExecution(r).ok).toBe(true);
  });

  it("records the principal verbatim, byte-for-byte (S-US3.8)", () => {
    expect(record({ caller: { principal: "user:bob" } }).spec.principal).toBe("user:bob");
  });

  it("does not split principal_not_allowed: anonymous and wrong-principal denials carry the identical code and message, differing only in the principal key (S-US3.7)", () => {
    const status = { phase: "denied", message: "not permitted", denialReason: "principal_not_allowed" } as const;
    const anon = record({ status });
    const wrong = record({ caller: { principal: "user:mallory" }, status });
    expect(anon.status).toEqual(wrong.status);
    expect("principal" in anon.spec).toBe(false);
    expect(wrong.spec.principal).toBe("user:mallory");
  });
});

describe("buildExecutionRecord — policyRuleIds, the drift signal (BR-11, D-5)", () => {
  it("is present and EMPTY when the capability carries no resolved policy (S-US10.3)", () => {
    const r = record();
    expect(r.spec.policyRuleIds).toEqual([]);
    expect("policyRuleIds" in r.spec).toBe(true);
    expect(validateExecution(r).ok).toBe(true);
  });

  it("lists the resolved rule ids on an ALLOWED record, not only a denied one (S-US10.1, EC-6)", () => {
    const rules = [{ id: "treasury-baseline", allow: ["user:alice"] }, { id: "transfer-limits" }];
    const r = record({ tool: tool({ policyRules: rules }), status: { phase: "succeeded" } });
    expect(r.spec.policyRuleIds).toEqual(["treasury-baseline", "transfer-limits"]);
  });

  it("carries IDS ONLY — never an allow/deny array, on any phase (BR-11, ADD-44 §3)", () => {
    const r = record({
      tool: tool({ policyRules: [{ id: "treasury-baseline", allow: ["user:alice", "role:treasury"], deny: ["user:offboarded"] }] }),
      status: { phase: "denied", message: "no", denialReason: "principal_not_allowed" },
    });
    const serialized = JSON.stringify(r);
    for (const entry of ["user:alice", "role:treasury", "user:offboarded"]) {
      expect(serialized).not.toContain(entry);
    }
    expect(r.spec.policyRuleIds).toEqual(["treasury-baseline"]);
  });

  it("omits a non-string rule id rather than coercing it, and never throws on a malformed artifact (EC-7)", () => {
    const rules = [{ id: 7 }, { id: "real" }, null] as unknown as IRTool["policyRules"];
    const r = record({ tool: tool({ policyRules: rules }) });
    expect(r.spec.policyRuleIds).toEqual(["real"]);
    expect(validateExecution(r).ok).toBe(true);
  });
});

describe("buildExecutionRecord — redaction (BR-35…BR-39, US-5)", () => {
  it("replaces an input value byte-identical to the caller credential with the fixed marker (S-US5.4)", () => {
    const r = record({ input: { note: "SUPER-SECRET-TOKEN-9f3a", other: "fine" }, caller: { accessToken: "SUPER-SECRET-TOKEN-9f3a" } });
    expect(JSON.stringify(r)).not.toContain("SUPER-SECRET-TOKEN-9f3a");
    expect(r.spec.input.note).toBe(REDACTED);
    expect(r.spec.input.other).toBe("fine");
  });

  it("scrubs at any depth, inside arrays and nested objects", () => {
    const r = record({
      input: { a: [{ b: { c: ["tok-1", "keep"] } }] },
      caller: { accessToken: "tok-1" },
    });
    expect(JSON.stringify(r)).not.toContain("tok-1");
    expect(JSON.stringify(r)).toContain("keep");
  });

  it("scrubs a credential echoed into the status message too — the scrub covers the whole record (BR-37)", () => {
    const r = record({
      status: { phase: "failed", message: "request failed: bad token tok-9 rejected" },
      caller: { accessToken: "tok-9" },
    });
    expect(r.status.message).toBe(`request failed: bad token ${REDACTED} rejected`);
  });

  it("uses an identical, non-reversible marker for two different tokens (S-US5.8)", () => {
    const short = "0000";
    const long = "1111111111111111111111111111111111111111";
    const a = record({ input: { t: short }, caller: { accessToken: short } });
    const b = record({ input: { t: long }, caller: { accessToken: long } });
    expect(a.spec.input.t).toBe(b.spec.input.t); // identical marker for two different tokens
    const marker = String(a.spec.input.t);
    expect(marker).toBe(REDACTED);
    expect(marker).not.toContain(String(short.length)); // no length
    expect(marker).not.toContain(String(long.length));
    expect(marker).not.toContain("0"); // no prefix, suffix or digest of either value
    expect(marker).not.toContain("1");
  });

  it("over-redacts rather than under-redacts: a pathologically SHORT credential mangles unrelated text — the accepted cost of a substring scrub", () => {
    // Characterization, not aspiration. The scrub replaces every OCCURRENCE, not only a
    // whole-value match, because the property a deployer needs is that the credential appears
    // nowhere in the emitted bytes — a token embedded in a longer string (an error message
    // interpolating a caller-derived host, an agent passing "Bearer <token>" as input) would
    // survive whole-value matching. The price is visible here. It is paid deliberately: in an
    // evidentiary log over-redaction is a nuisance and under-redaction is a security
    // regression. If this ever needs a minimum-length floor, that is a decision to argue for,
    // not a bug to fix quietly.
    const r = record({ input: { note: "the cat sat" }, caller: { accessToken: "a" } });
    expect(r.spec.input.note).toBe(`the c${REDACTED}t s${REDACTED}t`);
  });

  it("does NOT scrub an empty-string credential — that would replace every empty string in the record", () => {
    const r = record({ input: { note: "" }, caller: { accessToken: "" } });
    expect(r.spec.input.note).toBe("");
  });

  it("scrubs the principal when a deployer uses the credential AS the principal — the credential rule wins (BR-35 is absolute)", () => {
    const r = record({ caller: { principal: "tok-same", accessToken: "tok-same" } });
    expect(JSON.stringify(r)).not.toContain("tok-same");
    expect(r.spec.principal).toBe(REDACTED);
  });

  it("carries no field for a credential, a header, a URL, a body, a tenant, an effect or an HTTP status (S-US5.5, S-US5.7, EC-19, EC-20)", () => {
    const r = record({ caller: { principal: "user:alice", accessToken: "caller-token-7d1e", tenantId: "tenant-a" } as never });
    expect(Object.keys(r.spec).sort()).toEqual(["consumer", "input", "policyRuleIds", "principal"]);
    expect(Object.keys(r.metadata).sort()).toEqual(["capabilityId", "completedAt", "id", "provider", "startedAt"]);
    expect(JSON.stringify(r)).not.toContain("tenant-a");
    // `ExecutionStatus` has no `output` member at all — the schema declares the property and
    // this emitter has no code path that writes it (D-7). Read through a cast precisely because
    // the type refuses to name it.
    expect(Object.keys(r.status)).not.toContain("output");
    expect((r.status as unknown as Record<string, unknown>).output).toBeUndefined();
  });
});

describe("buildExecutionRecord — the record shares nothing with the invocation (BR-30, EC-2)", () => {
  it("deep-copies the input, so a sink that mutates the record cannot touch what was invoked", () => {
    const input: Record<string, unknown> = { nested: { keep: 1 } };
    const r = record({ input });
    (r.spec.input.nested as Record<string, unknown>).keep = 999;
    delete r.spec.input.nested;
    expect(input).toEqual({ nested: { keep: 1 } });
  });

  it("builds a record for a CIRCULAR input without hanging or throwing — serialization is the sink's problem", () => {
    const input: Record<string, unknown> = { name: "loop" };
    input.self = input;
    const r = record({ input });
    expect(r.spec.input.name).toBe("loop");
    expect(r.spec.input.self).toBe(r.spec.input); // the cycle is preserved, not expanded
    expect(() => JSON.stringify(r)).toThrow();
  });

  it("two records built from the same input share no state (S-US1.5, EC-18)", () => {
    const input = { a: 1 };
    const one = record({ input });
    const two = record({ input });
    expect(one.spec.input).not.toBe(two.spec.input);
    expect(one.metadata.id).not.toBe(two.metadata.id);
  });
});

describe("buildExecutionRecord — pass-through correlation ids (BR-23, S-US2.8)", () => {
  it("omits both keys entirely when the host supplied neither — no synthesized value", () => {
    const r = record();
    expect("sessionId" in r.metadata).toBe(false);
    expect("workflowId" in r.metadata).toBe(false);
  });

  it("carries the host's values verbatim when supplied", () => {
    const r = record({ sessionId: "sess-7", workflowId: "wf-3" });
    expect(r.metadata.sessionId).toBe("sess-7");
    expect(r.metadata.workflowId).toBe("wf-3");
    expect(validateExecution(r).ok).toBe(true);
  });
});

describe("emitExecutionRecord — the #39 fail-safe discipline, applied to audit (BR-27…BR-31)", () => {
  it("swallows a synchronous throw and reports it once per failure, naming the capability (BR-27, BR-31, S-US6.4)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink: AuditSink = () => {
      throw new Error("boom");
    };
    for (let i = 0; i < 3; i += 1) {
      expect(() => emitExecutionRecord(sink, record())).not.toThrow();
    }
    expect(err).toHaveBeenCalledTimes(3); // three failures, three lines — never deduplicated
    expect(String(err.mock.calls[0][0])).toContain("bank.list");
    expect(String(err.mock.calls[0][0])).toContain("record lost");
    err.mockRestore();
  });

  it("catches a rejected Promise without awaiting it (BR-28)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    emitExecutionRecord(() => Promise.reject(new Error("nope")), record());
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("returns SYNCHRONOUSLY for a sink that never settles (BR-29)", () => {
    // Not a wall-clock race: `emitExecutionRecord` returns `void`, so it cannot have awaited
    // anything. The clock is a loose secondary guard only.
    const started = Date.now();
    const returned = emitExecutionRecord(() => new Promise<void>(() => {}), record());
    expect(returned).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is a strict no-op with no sink — nothing is called (BR-34)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => emitExecutionRecord(undefined, record())).not.toThrow();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("jsonLinesAuditSink — the reference sink (BR-24, BR-26, US-7)", () => {
  function target(): { lines: string[]; write(chunk: string): void } {
    const lines: string[] = [];
    return { lines, write: (chunk: string) => void lines.push(chunk) };
  }

  it("writes one newline-terminated, schema-valid JSON line per record, with no flush and no second call (S-US7.1, S-US7.3)", () => {
    const t = target();
    const sink = jsonLinesAuditSink(t);
    sink(record());
    expect(t.lines).toHaveLength(1); // observable immediately — no buffer, no batch, no timer
    sink(record());
    sink(record());
    expect(t.lines).toHaveLength(3);
    for (const line of t.lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(validateExecution(JSON.parse(line)).ok).toBe(true);
    }
  });

  it("REFUSES process.stdout at construction time — stdout is the MCP protocol channel (BR-24, S-US7.2)", () => {
    expect(() => jsonLinesAuditSink(process.stdout)).toThrow(/stdout is the MCP protocol channel/);
  });

  it("defaults to stderr and never writes to stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    jsonLinesAuditSink()(record());
    expect(errWrite).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveBeenCalled();
    out.mockRestore();
    errWrite.mockRestore();
  });

  it("surfaces an unserializable record as an ordinary sink failure the invocation survives (EC-2, S-US6.8)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const input: Record<string, unknown> = {};
    input.self = input;
    emitExecutionRecord(jsonLinesAuditSink(target()), record({ input }));
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("record lost");
    err.mockRestore();
  });
});

describe("the denial vocabulary — six codes, five producers (D-4, BR-13, BR-14)", () => {
  it("the policy evaluator's union stays exactly four and cannot spell either lifecycle code (S-US3.5)", () => {
    const four: PolicyDenialReason[] = [
      "authenticated_no_credential",
      "principal_not_allowed",
      "principal_denied",
      "policy_unevaluatable",
    ];
    expect(four).toHaveLength(4);
    // @ts-expect-error — `lifecycle_blocked` is NOT a PolicyDenialReason; the evaluator can
    // never return it. If this stops erroring, the evaluator's contract was widened.
    const widenedBlocked: PolicyDenialReason = "lifecycle_blocked";
    expect(widenedBlocked).toBe(LIFECYCLE_BLOCKED_REASON);
    // @ts-expect-error — same for `lifecycle_unevaluatable` (ADD-56, BR-5): the evaluator can
    // never return it either — it is produced exclusively by the exposure gate.
    const widenedUnevaluatable: PolicyDenialReason = "lifecycle_unevaluatable";
    expect(widenedUnevaluatable).toBe(LIFECYCLE_UNEVALUATABLE_REASON);
  });

  it("the schema closes denialReason — free text FAILS validation (S-US3.6, BR-12, S-US7.2)", () => {
    const r = record({ status: { phase: "denied", message: "x" } }) as ExecutionRecord;
    (r.status as { denialReason?: string }).denialReason = "some_other_reason";
    expect(validateExecution(r).ok).toBe(false);
    for (const reason of [
      "authenticated_no_credential",
      "principal_not_allowed",
      "principal_denied",
      "policy_unevaluatable",
      "lifecycle_blocked",
      "lifecycle_unevaluatable",
    ]) {
      (r.status as { denialReason?: string }).denialReason = reason;
      expect(validateExecution(r).ok).toBe(true);
    }
  });

  it("the schema rejects an undeclared key and a missing policyRuleIds (S-US2.2, BR-7)", () => {
    const withExtra = { ...record(), extra: 1 };
    expect(validateExecution(withExtra).ok).toBe(false);
    const r = record() as ExecutionRecord;
    delete (r.spec as { policyRuleIds?: string[] }).policyRuleIds;
    expect(validateExecution(r).ok).toBe(false);
  });

  it("the schema rejects the two phases this increment never emits being smuggled in as free text", () => {
    const r = record() as ExecutionRecord;
    (r.status as { phase: string }).phase = "not_a_phase";
    expect(validateExecution(r).ok).toBe(false);
  });
});

// ADD-56 (#56) D-3/BR-20…BR-23, US-7: the schema/type widening is additive — nothing that
// validated before this increment stops validating, and the new member is rejected until now.
describe("ADD-56 — the schema edit is additive (US-7, BR-20…BR-23)", () => {
  it("S-US7.1: every pre-existing denialReason value, and no denialReason at all, still validates against the post-#56 schema", () => {
    const preExisting: (ExecutionDenialReason | undefined)[] = [
      "authenticated_no_credential",
      "principal_not_allowed",
      "principal_denied",
      "policy_unevaluatable",
      "lifecycle_blocked",
      undefined,
    ];
    for (const denialReason of preExisting) {
      const r = record({ status: { phase: denialReason ? "denied" : "succeeded", denialReason } }) as ExecutionRecord;
      expect(validateExecution(r).ok).toBe(true);
    }
  });

  it("BR-23: ExecutionDenialReason widens to include lifecycle_unevaluatable, additively", () => {
    const widened: ExecutionDenialReason = LIFECYCLE_UNEVALUATABLE_REASON;
    expect(widened).toBe("lifecycle_unevaluatable");
  });

  it("lifecycle_unevaluatable is a real member producible by buildExecutionRecord and validates end to end", () => {
    const r = record({ status: { phase: "denied", message: "x", denialReason: LIFECYCLE_UNEVALUATABLE_REASON } });
    expect(r.status.denialReason).toBe("lifecycle_unevaluatable");
    expect(validateExecution(r)).toEqual({ ok: true, errors: "" });
  });
});

describe("contractViolationMessage — one spelling shared by both consumers (BR-15, BR-44)", () => {
  it("is byte-for-byte the text the MCP path has always returned", () => {
    expect(contractViolationMessage("bank.list", ["iban", "balance"])).toBe(
      "contract violation: capability 'bank.list' — provider response is missing required field(s): iban, balance. Declared output shape not met; raw body withheld.",
    );
  });
});
