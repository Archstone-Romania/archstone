import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #44 (ADD-44 D-8 / BR-25 / S-US7.4) — the CLI configures NO audit sink, and unlike #39's
// callback this is a refusal rather than a structural impossibility: a file-path flag *is*
// CLI-expressible. The reason it is refused: the CLI wires no identity seam at all, so every
// row of a CLI-produced trail would carry no principal — evidence-shaped output that answers
// "who" with silence in every single row, which is worse than no log. **Revisit when the CLI
// gains an identity seam, in that same increment and not before.**
//
// Also pins two layer-purity facts the increment's DoD names (S-US9.4, S-US9.5): no audit
// concept lowers into the IR, and the REST provider never reads the sink it carries.

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(here, p), "utf8");

const cliSource = read("../src/index.ts");
const irSource = read("../../compiler/src/ir.ts");
const restSource = read("../../../providers/rest/src/index.ts");

describe("archstone CLI — no audit sink surface anywhere (BR-25, D-8, S-US7.4)", () => {
  it("the CLI source never references an audit sink, a record, or a log path", () => {
    expect(cliSource).not.toMatch(/auditSink|AuditSink|jsonLinesAuditSink|ExecutionRecord/);
  });

  it("its usage text advertises no --audit/--audit-log/--sink flag", () => {
    expect(cliSource).not.toMatch(/--audit|--sink|--log-?file/i);
    // The second assertion is a CANARY: it proves the usage text still exists and still
    // enumerates the verbs, so the first assertion is checking something real rather than a
    // string that quietly disappeared. It deliberately does NOT pin the exact verb list —
    // `init` joining it is a normal event, and a test that fails on a new verb teaches people
    // to loosen the audit assertion next to it.
    expect(cliSource).toMatch(/usage: archstone <apply\|serve\|verify\|build/);
  });

  it("serve, serve --http and verify still pass no invoke options of any kind", () => {
    expect(cliSource).toMatch(/serveStdio\(dir\)/);
    expect(cliSource).toMatch(/createHttpHandler\(built\.registry,\s*\{\s*bearerToken:\s*token\s*\}\)/);
    expect(cliSource).toMatch(/runVerify\(registry\.listCapabilities\(\),\s*dir,\s*registry\.ir\.resources\)/);
  });
});

describe("layer purity (BR-42, S-US9.4, S-US9.5)", () => {
  it("no audit, record, sink or Execution concept appears in the IR (compiler/src/ir.ts)", () => {
    expect(irSource).not.toMatch(/\bauditSink\b|\bAuditSink\b|\bExecutionRecord\b|\bExecution\b/);
    expect(irSource).toMatch(/version: "0"/); // the IR version is unchanged by this increment
  });

  it("providers/rest carries the sink field but NEVER reads it — the type import is the only mention outside the doc comment", () => {
    // `invokeRest`'s body must not branch on, call, or destructure the sink. Everything after
    // the InvokeOptions declaration is implementation.
    const body = restSource.slice(restSource.indexOf("function fireOnResponse"));
    expect(body).not.toMatch(/auditSink/);
    // …and it is genuinely declared on the bag, so a deployer keeps one options object.
    expect(restSource).toMatch(/auditSink\?: AuditSink;/);
  });
});
