import { describe, it, expect } from "vitest";
import type { ExecutionRecord } from "@archstone/emitter-support";
import { applyFilter, parseAuditLines, summarize, toCsv } from "../src/audit-report";

function rec(over: {
  startedAt?: string;
  capabilityId?: string;
  phase?: "succeeded" | "failed" | "denied";
  denialReason?: string;
  principal?: string;
} = {}): ExecutionRecord {
  return {
    apiVersion: "archstone/v1",
    kind: "Execution",
    metadata: {
      id: "exec-1",
      capabilityId: over.capabilityId ?? "framing.estimate-frame-price",
      provider: "artvinci",
      startedAt: over.startedAt ?? "2026-08-21T09:00:00.000Z",
      completedAt: "2026-08-21T09:00:00.400Z",
    },
    spec: {
      input: {},
      consumer: "mcp",
      ...(over.principal === undefined ? {} : { principal: over.principal }),
      policyRuleIds: [],
    },
    status: {
      phase: over.phase ?? "succeeded",
      ...(over.denialReason ? { denialReason: over.denialReason as never } : {}),
    },
  } as ExecutionRecord;
}

describe("parseAuditLines", () => {
  it("reads records and ignores blank lines without calling them skipped", () => {
    const text = `${JSON.stringify(rec())}\n\n${JSON.stringify(rec())}\n`;
    const out = parseAuditLines(text);
    expect(out.records).toHaveLength(2);
    // A trailing newline is normal, not a defect — reporting it would train operators to
    // ignore the skip line, which is the one thing it must not do.
    expect(out.skipped).toEqual([]);
  });

  it("reports unreadable lines instead of dropping them silently", () => {
    const text = `${JSON.stringify(rec())}\n{ not json\n${JSON.stringify({ kind: "Something" })}\n`;
    const out = parseAuditLines(text);
    expect(out.records).toHaveLength(1);
    expect(out.skipped).toEqual([
      { line: 2, reason: "not valid JSON" },
      { line: 3, reason: "not an Execution record" },
    ]);
  });
});

describe("applyFilter", () => {
  const records = [
    rec({ startedAt: "2026-08-01T00:00:00.000Z" }),
    rec({ startedAt: "2026-08-15T00:00:00.000Z", phase: "denied", denialReason: "rate_limit_exceeded" }),
    rec({ startedAt: "2026-09-01T00:00:00.000Z", capabilityId: "framing.list-frame-profiles" }),
  ];

  it("is inclusive on --since and exclusive on --until, so adjacent ranges tile", () => {
    const august = applyFilter(records, { since: "2026-08-01", until: "2026-09-01" });
    const september = applyFilter(records, { since: "2026-09-01", until: "2026-10-01" });
    expect(august).toHaveLength(2);
    expect(september).toHaveLength(1);
    // The boundary record is counted once across the two ranges, never twice, never zero times.
    expect(august.length + september.length).toBe(records.length);
  });

  it("filters by capability and phase", () => {
    expect(applyFilter(records, { capability: "framing.list-frame-profiles" })).toHaveLength(1);
    expect(applyFilter(records, { phase: "denied" })).toHaveLength(1);
  });

  it("separates 'no principal' from 'the principal was an empty string'", () => {
    const mixed = [rec({ principal: "user:alice" }), rec({ principal: "" }), rec()];

    expect(applyFilter(mixed, { principal: "user:alice" })).toHaveLength(1);
    // `anonymous` is the absence of the field — ADD-42 D-4 makes that a real distinction.
    expect(applyFilter(mixed, { anonymous: true })).toHaveLength(1);
    // …and an empty-string principal is a present value a host can legitimately supply, so it
    // is NOT anonymous. Conflating the two (the v0.12.0 shape) answered the wrong question for
    // anyone who typed `--principal ""` meaning "no principal".
    expect(applyFilter(mixed, { principal: "" })).toHaveLength(1);
    expect(applyFilter(mixed, { anonymous: true })[0].spec.principal).toBeUndefined();
  });
});

describe("toCsv", () => {
  it("escapes anything that could change the shape of a row", () => {
    const csv = toCsv([rec({ capabilityId: 'weird,"id' })]);
    const [header, row] = csv.split("\n");
    expect(header.startsWith("startedAt,completedAt,capabilityId")).toBe(true);
    expect(row).toContain('"weird,""id"');
    expect(row.split("\n")).toHaveLength(1);
  });

  it("omits spec.input — payloads do not belong in a file that gets emailed around", () => {
    expect(toCsv([rec()])).not.toContain("input");
  });
});

describe("summarize", () => {
  it("separates denials from failures, and orders deterministically", () => {
    const out = summarize([
      rec({ phase: "denied", denialReason: "rate_limit_exceeded" }),
      rec({ phase: "denied", denialReason: "rate_limit_exceeded" }),
      rec({ phase: "denied", denialReason: "principal_not_allowed" }),
      rec({ phase: "failed" }),
    ]);
    expect(out).toContain("Denials by reason");
    expect(out.indexOf("rate_limit_exceeded")).toBeLessThan(out.indexOf("principal_not_allowed"));
    // A failure is the backend going wrong; a denial is governance working. Different questions.
    expect(out).toContain("failed");
  });

  it("says so plainly when nothing matched", () => {
    expect(summarize([])).toBe("No records matched.");
  });
});
