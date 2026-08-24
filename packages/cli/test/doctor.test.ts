import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IR, IRTool } from "@archstone/compiler";
import { diagnose, formatReport } from "../src/doctor";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "archstone-doctor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "tourism.search",
    description: "Find stays.",
    effect: "read",
    provider: "stays",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    connector: { type: "rest", rest: { method: "GET", path: "/search", baseUrl: "https://api.example.test" } },
    ...over,
  } as IRTool;
}

const ir = (tools: IRTool[]): IR => ({ version: "0", company: { id: "acme" }, tools, resources: {} });
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("diagnose — what blocks", () => {
  it("errors when a caller can influence the baseUrl, because that is the SSRF shape", () => {
    const r = diagnose(
      ir([tool({ connector: { type: "rest", rest: { method: "GET", path: "/x", baseUrl: "${caller.tenantUrl}" } } })]),
      dir,
    );
    expect(codes(r)).toContain("caller-influenced-baseurl");
    expect(r.ok).toBe(false); // errors block; everything else does not
  });

  it("errors when a contract names a fixture that is not on disk", () => {
    const r = diagnose(ir([tool({ contract: { fingerprint: "sha256:x", probeFixture: "fixtures/gone.json" } })]), dir);
    expect(codes(r)).toContain("missing-fixture-file");
    expect(r.ok).toBe(false);
  });

  it("passes when the fixture is actually there", () => {
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "there.json"), "{}");
    const r = diagnose(ir([tool({ contract: { fingerprint: "sha256:x", probeFixture: "fixtures/there.json" } })]), dir);
    expect(codes(r)).not.toContain("missing-fixture-file");
    expect(r.ok).toBe(true);
  });

  it("errors when the committed IR artifact does not match a fresh build", () => {
    writeFileSync(join(dir, "archstone.ir.json"), '{"version":"0","tools":[]}\n');
    const r = diagnose(ir([tool()]), dir, { builtIr: '{"version":"0","tools":[{"id":"tourism.search"}]}\n' });
    expect(codes(r)).toContain("ir-drift");
    expect(r.ok).toBe(false);
  });

  it("does not report drift when there is no committed artifact to drift from", () => {
    const r = diagnose(ir([tool()]), dir, { builtIr: "{}\n" });
    expect(codes(r)).not.toContain("ir-drift");
  });
});

describe("diagnose — what warns", () => {
  it("flags a capability with no binding", () => {
    const r = diagnose(ir([tool({ connector: undefined })]), dir);
    expect(codes(r)).toContain("unbound-capability");
    expect(r.ok).toBe(true); // a warning is not a blocker
  });

  it("does not flag a retired capability for being unbound — that is the point of retiring it", () => {
    const r = diagnose(ir([tool({ connector: undefined, lifecycle: "retired" })]), dir);
    expect(codes(r)).not.toContain("unbound-capability");
  });

  it("flags a bound capability with no contract, because verify would have nothing to replay", () => {
    expect(codes(diagnose(ir([tool()]), dir))).toContain("no-contract");
  });
});

describe("diagnose — what it makes you look at", () => {
  it("surfaces every irreversible effect for re-confirmation", () => {
    const r = diagnose(ir([tool({ effect: "irreversible" })]), dir);
    expect(codes(r)).toContain("irreversible-effect");
    expect(r.findings.find((f) => f.code === "irreversible-effect")?.because).toMatch(/charging a card/);
  });

  it("says a declared rate limit needs a counter, and a shared one on more than one instance", () => {
    const r = diagnose(
      ir([tool({ policyRules: [{ id: "p", rateLimit: { maxInvocations: 100, windowSeconds: 60 } }] })]),
      dir,
    );
    expect(codes(r)).toContain("ratelimit-needs-counter");
  });

  it("says an authenticated capability cannot be served from stdio's single static caller", () => {
    const r = diagnose(ir([tool({ policies: ["authenticated"] })]), dir);
    expect(r.findings.find((f) => f.code === "authenticated-needs-principal")?.because).toMatch(/stdio/);
  });

  it("notes that experimental capabilities stay invocable by id", () => {
    expect(codes(diagnose(ir([tool({ lifecycle: "experimental" })]), dir))).toContain("experimental-capability");
  });

  it("notes an env-supplied baseUrl without treating it as a defect", () => {
    const r = diagnose(
      ir([tool({ connector: { type: "rest", rest: { method: "GET", path: "/x", baseUrl: "${STAYS_API_URL}" } } })]),
      dir,
    );
    expect(codes(r)).toContain("env-baseurl");
    expect(r.ok).toBe(true);
  });
});

describe("formatReport", () => {
  it("puts errors first, so a reader who stops early sees what blocks", () => {
    const r = diagnose(
      ir([
        tool({ effect: "irreversible", connector: { type: "rest", rest: { method: "GET", path: "/x", baseUrl: "${caller.x}" } } }),
      ]),
      dir,
    );
    const out = formatReport(r, "manifest");
    expect(out.indexOf("🔴")).toBeLessThan(out.indexOf("🔵"));
  });

  it("says so plainly when there is nothing to flag", () => {
    mkdirSync(join(dir, "f"));
    writeFileSync(join(dir, "f", "x.json"), "{}");
    const clean = diagnose(ir([tool({ contract: { fingerprint: "s", probeFixture: "f/x.json" } })]), dir);
    expect(formatReport(clean, "manifest")).toContain("nothing to flag");
  });
});
