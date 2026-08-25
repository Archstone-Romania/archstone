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

// #125 (ADD-124 D-10/D-12): `doctor` used to emit two advisories on the same `irreversible`
// capability that contradicted each other — "record a fixture so verify replays it in CI" and,
// fifty lines below, "must never auto-retry". `verify` wired into CI IS an auto-retry,
// mechanically. An advisory that recommends a dangerous action is worse than a missing check,
// because it launders the action as reviewed.
describe("diagnose — no-contract is effect-aware (#125)", () => {
  const findingFor = (r: { findings: { code: string; severity: string; because: string; message: string }[] }, code: string) =>
    r.findings.find((f) => f.code === code);

  for (const effect of ["write", "irreversible"] as const) {
    it(`does NOT advise recording a fixture for a bound \`${effect}\` capability`, () => {
      const r = diagnose(ir([tool({ effect })]), dir);
      // THE DoD ASSERTION.
      expect(codes(r)).not.toContain("no-contract");
      expect(codes(r)).toContain("no-contract-non-read");
      expect(r.ok).toBe(true);
    });

    it(`its --json code is DISTINCT from the read case, so a dashboard filtering \`no-contract\` cannot merge them (\`${effect}\`)`, () => {
      const nonRead = codes(diagnose(ir([tool({ effect })]), dir));
      const read = codes(diagnose(ir([tool({ effect: "read" })]), dir));
      expect(read).toContain("no-contract");
      expect(read).not.toContain("no-contract-non-read");
      expect(nonRead).toContain("no-contract-non-read");
      expect(nonRead).not.toContain("no-contract");
    });
  }

  it("says the opposite thing, and names both alternatives — the read twin and a sandbox-scoped run", () => {
    const f = findingFor(diagnose(ir([tool({ effect: "irreversible" })]), dir), "no-contract-non-read")!;
    expect(f.severity).toBe("advisory"); // having no fixture here is the CORRECT state, not a gap
    expect(f.because).toMatch(/`read` counterpart/);
    expect(f.because).toMatch(/--sandbox/);
    expect(f.because).toMatch(/skips it by default/);
    // D-11's honesty doctrine, applied to the prose itself: the advisory must not PRESUME the
    // capability has a read counterpart (plenty do not — `delete-account`, `send-notification`),
    // and must not imply Archstone could name it. Nothing in CDL declares that relationship, so
    // guessing one would sometimes name the wrong capability with the same confidence as the
    // right one. `index.ts`'s READ_TWIN_TIP hedges the same way; these two must not drift apart.
    expect(f.because).toMatch(/Not every write has one/);
    expect(f.because).toMatch(/Archstone cannot tell you which capability it is/);
  });

  it("the read branch is untouched — same code, severity and prose as before the split", () => {
    const f = findingFor(diagnose(ir([tool({ effect: "read" })]), dir), "no-contract")!;
    expect(f.severity).toBe("warning");
    expect(f.message).toBe("bound, but records no contract fixture");
    expect(f.because).toMatch(/backend drift is found by an agent, in front of a customer, instead of by CI/);
  });

  it("the two advisories on ONE irreversible capability now agree instead of colliding", () => {
    const r = diagnose(ir([tool({ effect: "irreversible" })]), dir);
    expect(codes(r)).toContain("irreversible-effect");
    expect(codes(r)).toContain("no-contract-non-read");
    // Both must point at the same conclusion. `irreversible-effect` keeps its code, severity and
    // original text, and gains one sentence naming `verify`'s new default (D-12) — so a reader
    // hits no contradiction wherever they start reading.
    const irreversible = findingFor(r, "irreversible-effect")!;
    expect(irreversible.severity).toBe("advisory");
    expect(irreversible.because).toMatch(/must never auto-retry/); // unchanged
    expect(irreversible.because).toMatch(/will not replay this capability's fixture/); // added
    expect(irreversible.because).toMatch(/--sandbox/);
  });

  it("an irreversible capability that DOES carry a contract is not told to record one, and its fixture is still checked", () => {
    // With a contract present, `no-contract-non-read` must not fire at all — the advisory is
    // about the absence, not about the effect. The fixture-on-disk error still applies, because
    // a contract pointing at a missing file is broken regardless of effect.
    const r = diagnose(ir([tool({ effect: "irreversible", contract: { fingerprint: "sha256:x", probeFixture: "fixtures/gone.json" } })]), dir);
    expect(codes(r)).not.toContain("no-contract-non-read");
    expect(codes(r)).not.toContain("no-contract");
    expect(codes(r)).toContain("missing-fixture-file");
    expect(codes(r)).toContain("irreversible-effect");
  });

  it("an UNBOUND non-read capability gets neither contract advisory — there is nothing to verify yet", () => {
    const r = diagnose(ir([tool({ effect: "write", connector: undefined })]), dir);
    expect(codes(r)).not.toContain("no-contract-non-read");
    expect(codes(r)).not.toContain("no-contract");
    expect(codes(r)).toContain("unbound-capability");
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
