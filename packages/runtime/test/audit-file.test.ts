import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRecord } from "@archstone/emitter-support";
import { rotatingFileAuditSink } from "../src/audit-file";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archstone-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(id: string): ExecutionRecord {
  return {
    apiVersion: "archstone/v1",
    kind: "Execution",
    metadata: {
      id,
      capabilityId: "framing.estimate-frame-price",
      provider: "artvinci",
      startedAt: "2026-08-21T09:00:00.000Z",
      completedAt: "2026-08-21T09:00:00.400Z",
    },
    spec: { input: {}, consumer: "mcp", policyRuleIds: [] },
    status: { phase: "succeeded" },
  } as ExecutionRecord;
}

describe("rotatingFileAuditSink", () => {
  it("writes one JSON line per record", () => {
    const path = join(dir, "audit.log");
    const sink = rotatingFileAuditSink({ path });
    sink(rec("a"));
    sink(rec("b"));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).metadata.id).toBe("a");
  });

  it("creates the directory at construction, not at the first record", () => {
    const path = join(dir, "nested", "deeper", "audit.log");
    rotatingFileAuditSink({ path });
    // A mistyped path is a wiring error; the deployer should meet it while looking at the
    // config, not as caught sink failures under load.
    expect(existsSync(join(dir, "nested", "deeper"))).toBe(true);
  });

  it("rotates by size and bounds total footprint by maxFiles", () => {
    const path = join(dir, "audit.log");
    const sink = rotatingFileAuditSink({ path, maxBytes: 400, maxFiles: 2 });

    for (let i = 0; i < 12; i++) sink(rec(`r${i}`));

    expect(existsSync(`${path}`)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    // The guarantee an operator plans disk against: at most maxFiles + 1 files, ever.
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it("moves generations along rather than overwriting them", () => {
    const path = join(dir, "audit.log");
    const sink = rotatingFileAuditSink({ path, maxBytes: 300, maxFiles: 3 });

    sink(rec("oldest"));
    sink(rec("second"));
    sink(rec("third"));

    // Each of these records is larger than maxBytes/2, so every write rotates: the generations
    // must walk outward in age order, newest live and oldest furthest out. Overwriting rather
    // than moving would show up here as the wrong id in .2.
    expect(readFileSync(path, "utf8")).toContain("third");
    expect(readFileSync(`${path}.1`, "utf8")).toContain("second");
    expect(readFileSync(`${path}.2`, "utf8")).toContain("oldest");
  });

  it("still writes a record larger than the whole budget", () => {
    const path = join(dir, "audit.log");
    const sink = rotatingFileAuditSink({ path, maxBytes: 10, maxFiles: 2 });

    sink(rec("first"));
    sink(rec("big"));

    // Dropping an oversized record loses evidence and teaches the operator nothing; one file
    // over budget is visible and fixable.
    expect(readFileSync(path, "utf8")).toContain("big");
  });

  it("rejects nonsense configuration at construction", () => {
    expect(() => rotatingFileAuditSink({ path: join(dir, "a.log"), maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => rotatingFileAuditSink({ path: join(dir, "a.log"), maxFiles: 0 })).toThrow(/maxFiles/);
  });
});
