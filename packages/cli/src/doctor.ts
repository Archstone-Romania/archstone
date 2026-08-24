// `archstone doctor` — the pre-production checklist, made runnable (#102).
//
// A-7 §5 is a list a human reads before go-live, and a list a human reads is a list a human
// skips. Everything on it except the two judgement steps is machine-checkable from the manifest
// and the compiled IR, so it is checked here instead.
//
// Deliberately offline: no backend is contacted, nothing is invoked, nothing is uploaded. That
// is `archstone verify`'s job and it already exists. `doctor` answers the question you ask
// *before* pointing anything at production — is this manifest wired the way a deployment needs?

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IR, IRTool } from "@archstone/compiler";

export type Severity = "error" | "warning" | "advisory";

export interface Finding {
  severity: Severity;
  /** Stable machine key, so a CI job can allowlist a specific finding without regex-matching prose. */
  code: string;
  capability?: string;
  message: string;
  /** Why it matters — the part that makes a checklist worth reading rather than obeying. */
  because: string;
}

export interface DoctorReport {
  findings: Finding[];
  checked: number;
  /** Errors block; warnings and advisories do not. */
  ok: boolean;
}

/** `${VAR}` (env) and `${caller.x}` — the two interpolations `providers/rest` resolves. */
const ENV_INTERP = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const CALLER_INTERP = /\$\{caller\./;

function baseUrlOf(tool: IRTool): string | undefined {
  return tool.connector?.rest?.baseUrl;
}

/**
 * Every check is a pure function of the IR plus what is on disk beside it. The manifest
 * directory is needed for exactly two of them — fixture existence and IR drift — and nothing
 * here writes.
 */
export function diagnose(ir: IR, manifestDir: string, opts: { builtIr?: string } = {}): DoctorReport {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  for (const tool of ir.tools) {
    const bound = tool.connector !== undefined;

    // --- invocability -----------------------------------------------------------------
    if (!bound && tool.lifecycle !== "retired") {
      add({
        severity: "warning",
        code: "unbound-capability",
        capability: tool.id,
        message: "declared but has no binding, so it is not invocable",
        because:
          "A capability with no binding compiles and then does nothing. That is fine while you are drafting and a defect at go-live.",
      });
    }

    // --- contract / fixtures ----------------------------------------------------------
    if (bound && !tool.contract) {
      add({
        severity: "warning",
        code: "no-contract",
        capability: tool.id,
        message: "bound, but records no contract fixture",
        because:
          "`archstone verify` replays a recorded fixture against the live backend. With no fixture there is nothing to replay, so backend drift is found by an agent, in front of a customer, instead of by CI.",
      });
    }
    if (tool.contract?.probeFixture) {
      const fixture = join(manifestDir, tool.contract.probeFixture);
      if (!existsSync(fixture)) {
        add({
          severity: "error",
          code: "missing-fixture-file",
          capability: tool.id,
          message: `contract names a fixture that is not on disk: ${tool.contract.probeFixture}`,
          because:
            "The contract points at a file that does not exist, so `verify` cannot run at all — a green pipeline that never checked anything.",
        });
      }
    }
    if (tool.lifecycle === "retired" && tool.contract) {
      add({
        severity: "advisory",
        code: "retired-with-contract",
        capability: tool.id,
        message: "is retired but still carries a contract fixture",
        because:
          "Retired capabilities are blocked on every surface, so the fixture is dead weight — harmless, but it makes the manifest read as though the capability is still live.",
      });
    }

    // --- egress -----------------------------------------------------------------------
    const baseUrl = baseUrlOf(tool);
    if (baseUrl && CALLER_INTERP.test(baseUrl)) {
      add({
        severity: "error",
        code: "caller-influenced-baseurl",
        capability: tool.id,
        message: "baseUrl interpolates caller-supplied data",
        because:
          "This is the SSRF shape: a caller who chooses part of the URL chooses where the request goes. Set `allowedHosts` on the provider, which constrains the resolved host to an allowlist.",
      });
    } else if (baseUrl && ENV_INTERP.test(baseUrl)) {
      add({
        severity: "advisory",
        code: "env-baseurl",
        capability: tool.id,
        message: `baseUrl comes from the environment (${baseUrl})`,
        because:
          "Nothing wrong with it — but the deployment, not the manifest, decides where this capability points. Confirm the variable is set to the intended backend in every environment that runs it.",
      });
    }

    // --- effects ----------------------------------------------------------------------
    if (tool.effect === "irreversible") {
      add({
        severity: "advisory",
        code: "irreversible-effect",
        capability: tool.id,
        message: "is declared `irreversible`",
        because:
          "No API description states this, so it was a human judgement: an agent must confirm explicitly and must never auto-retry. Re-read it before go-live — `irreversible` is the difference between looking up a price and charging a card.",
      });
    }

    // --- governance wiring ------------------------------------------------------------
    if (tool.policyRules?.some((r) => r.rateLimit !== undefined)) {
      add({
        severity: "advisory",
        code: "ratelimit-needs-counter",
        capability: tool.id,
        message: "declares a rate limit, which needs a counter supplied at runtime",
        because:
          "With no counter the call is denied, fail-closed, at the first invocation. On more than one instance the counter must be shared, or a declared 100/min becomes 100/min per instance.",
      });
    }
    if (tool.policies?.includes("authenticated")) {
      add({
        severity: "advisory",
        code: "authenticated-needs-principal",
        capability: tool.id,
        message: "requires an authenticated caller",
        because:
          "The surface serving it must carry a per-request principal — `resolveCaller` on HTTP or the embedded SDK. `archstone serve` (stdio) has one static caller for the whole process, so it cannot serve this capability to more than one identity.",
      });
    }
    if (tool.lifecycle === "experimental") {
      add({
        severity: "advisory",
        code: "experimental-capability",
        capability: tool.id,
        message: "is `experimental`: hidden from tool listings but still invocable by id",
        because:
          "Deliberate behaviour, and easy to forget: an agent that knows the id can still call it. Confirm that is what you want in production.",
      });
    }
  }

  // --- IR drift ------------------------------------------------------------------------
  if (opts.builtIr !== undefined) {
    const committed = join(manifestDir, "archstone.ir.json");
    if (existsSync(committed)) {
      const onDisk = readFileSync(committed, "utf8");
      if (onDisk.trim() !== opts.builtIr.trim()) {
        add({
          severity: "error",
          code: "ir-drift",
          message: "the committed archstone.ir.json does not match a fresh build of this manifest",
          because:
            "The artifact is what runs. A stale one enforces stale policy and exposes stale tools, silently — rebuild it and commit the result.",
        });
      }
    }
  }

  return {
    findings,
    checked: ir.tools.length,
    ok: !findings.some((f) => f.severity === "error"),
  };
}

const ICON: Record<Severity, string> = { error: "🔴", warning: "🟡", advisory: "🔵" };

export function formatReport(report: DoctorReport, dir: string): string {
  const lines = [`\narchstone doctor ${dir}\n`];
  if (report.findings.length === 0) {
    lines.push(`🟢 ${report.checked} capabilities checked — nothing to flag.\n`);
    return lines.join("\n");
  }
  // Errors first: a reader who stops after five lines should have seen what blocks.
  const order: Severity[] = ["error", "warning", "advisory"];
  for (const sev of order) {
    for (const f of report.findings.filter((x) => x.severity === sev)) {
      lines.push(`${ICON[sev]} ${f.capability ? `${f.capability} — ` : ""}${f.message}`);
      lines.push(`   ${f.because}`);
      lines.push(`   (${f.code})\n`);
    }
  }
  const counts = order.map((s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`).join(" · ");
  lines.push(`${report.checked} capabilities checked — ${counts}.\n`);
  return lines.join("\n");
}
