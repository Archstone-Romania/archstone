#!/usr/bin/env node
// @archstone/cli — `archstone apply` (#1) + `archstone serve` (#7) + `archstone verify` (#18-20)
//
// apply: parse → shape-validate (#2) → semantic-validate (#3) → compile IR (#4)
//        → index Registry (#5), and REPORT (human output, exits).
// serve: build the registry and expose it as an MCP server over stdio (#7),
//        so Claude/Cursor/ChatGPT can discover and invoke the tools. Blocks.
// verify: replay each bound capability's golden fixture against the LIVE backend
//         and report a per-binding health status (ADD-18). The only command that
//         makes a network call outside a real MCP invocation — on demand, never
//         scheduled by Archstone itself (wire it into your own CI/cron).

import { load } from "@archstone/schema";
import { validateSemantics, compile } from "@archstone/compiler";
import { Registry, serveStdio, runVerify, type HealthStatus } from "@archstone/runtime";

function runApply(dir: string): void {
  const res = load(dir);
  console.log(`\narchstone apply ${dir}\n`);

  if (res.capabilities) {
    const c = res.capabilities;
    console.log(`  company    ${c.company.name ?? c.company.id} (${c.company.id})`);
    console.log(`  providers  ${c.providers.join(", ")}`);
    console.log(`  declared   ${c.capabilities.length} capabilities`);
  }
  console.log(`  loaded     ${res.capabilityDocs.length} capability docs, ${res.bindings.length} bindings`);
  for (const d of res.capabilityDocs) {
    console.log(`    ✓ ${d.capability.id}  [${d.capability.effect}] → ${d.capability.provider ?? "?"}`);
  }

  // Shape (schema) issues from #2 — "valid shapes" is not "deployable".
  if (res.issues.length > 0) {
    console.log(`\n  ✗ ${res.issues.length} shape issue(s):`);
    for (const i of res.issues) console.log(`    - ${i.file}: ${i.message}`);
  } else {
    console.log(`\n  ✓ shapes valid`);
  }

  // Semantic pass (#3) — cross-file resolution; errors block, warnings inform.
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const warnings = diags.filter((d) => d.severity === "warning");
  console.log(`  semantic   ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const d of errors) console.log(`    ✗ ${d.message}`);
  for (const d of warnings) console.log(`    ⚠ ${d.message}`);

  const ok = res.ok && errors.length === 0;

  // Compile to IR (#4) + index into the Registry (#5) — only when valid enough to emit.
  if (ok) {
    const registry = new Registry(compile(res));
    const invocable = registry.listCapabilities().filter((t) => t.connector).length;
    console.log(`  registry   IR v${registry.ir.version} — ${registry.size} capabilities, ${invocable} invocable (bound)`);
    console.log(`\n  → run 'archstone serve ${dir}' to expose ${invocable} tool(s) to an AI agent over MCP`);
  }

  console.log("");
  process.exit(ok ? 0 : 1);
}

const HEALTH_ICON: Record<HealthStatus, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

async function runVerifyCmd(dir: string): Promise<void> {
  const res = load(dir);
  const diags = validateSemantics(res);
  const ok = res.ok && !diags.some((d) => d.severity === "error");
  if (!ok) {
    console.error(`archstone verify ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    process.exit(2);
  }

  const registry = new Registry(compile(res));
  const reports = await runVerify(registry.listCapabilities(), dir, registry.ir.resources);

  console.log(`\narchstone verify ${dir}\n`);
  if (reports.length === 0) {
    console.log("  (no bindings declare a contract: — nothing to verify)\n");
    process.exit(0);
  }
  for (const r of reports) {
    console.log(`  ${HEALTH_ICON[r.status]} ${r.capabilityId} — ${r.detail}`);
  }
  console.log("");
  process.exit(reports.some((r) => r.status === "red") ? 1 : 0);
}

async function main(): Promise<void> {
  const [cmd, dir] = process.argv.slice(2);

  if (cmd === "apply" && dir) {
    runApply(dir);
    return;
  }
  if (cmd === "serve" && dir) {
    await serveStdio(dir); // blocks on the stdio transport
    return;
  }
  if (cmd === "verify" && dir) {
    await runVerifyCmd(dir);
    return;
  }

  console.error("usage: archstone <apply|serve|verify> <manifest-dir>");
  process.exit(2);
}

main();
