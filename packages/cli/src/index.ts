#!/usr/bin/env node
// @archstone/cli — `archstone apply` (#1) + `archstone serve` (#7)
//
// apply: parse → shape-validate (#2) → semantic-validate (#3) → compile IR (#4)
//        → index Registry (#5), and REPORT (human output, exits).
// serve: build the registry and expose it as an MCP server over stdio (#7),
//        so Claude/Cursor/ChatGPT can discover and invoke the tools. Blocks.

import { load } from "@archstone/schema";
import { validateSemantics, compile } from "@archstone/compiler";
import { Registry, serveStdio } from "@archstone/runtime";

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

  console.error("usage: archstone <apply|serve> <manifest-dir>");
  process.exit(2);
}

main();
