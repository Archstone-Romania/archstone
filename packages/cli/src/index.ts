#!/usr/bin/env node
// @archstone/cli — `archstone apply` (#1) + `archstone serve` (#7, + `--http` ADD-0008 #29)
//                  + `archstone verify` (#18-20) + `archstone build` (ADD-0008 #27)
//
// apply: parse → shape-validate (#2) → semantic-validate (#3) → compile IR (#4)
//        → index Registry (#5), and REPORT (human output, exits).
// serve: build the registry and expose it as an MCP server over stdio (#7),
//        so Claude/Cursor/ChatGPT can discover and invoke the tools. Blocks.
// serve --http: same registry, served over real Streamable-HTTP instead of stdio —
//        `@archstone/runtime/http`'s createHttpHandler (Web-standard Request/Response,
//        bearer-token gated, shared with @archstone/agent/mcp's mcpHandler(), ADD-0008 D-3)
//        behind a thin Node-http adapter. Blocks.
// verify: replay each bound capability's golden fixture against the LIVE backend
//         and report a per-binding health status (ADD-18). The only command that
//         makes a network call outside a real MCP invocation — on demand, never
//         scheduled by Archstone itself (wire it into your own CI/cron).
// build: run the same compile pipeline as `apply`, strip each tool's `contract`
//        (D-8 — the fingerprint/golden-fixture path is meaningless once the fixture
//        file isn't shipping), and write the IR as a standalone JSON artifact —
//        the substrate `@archstone/agent`'s `fromIR()` will consume (RFC-0008).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { load } from "@archstone/schema";
import { validateSemantics, compile, type IR } from "@archstone/compiler";
import { Registry, buildRegistry, serveStdio, runVerify, type HealthStatus } from "@archstone/runtime";
import { createHttpHandler } from "@archstone/runtime/http";

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

function runBuild(dir: string, outPath: string | undefined): void {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const ok = res.ok && errors.length === 0;

  if (!ok) {
    console.error(`archstone build ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    for (const i of res.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of errors) console.error(`  - ${d.message}`);
    process.exit(1);
  }

  const ir = compile(res);
  // D-8: the artifact ships with no code alongside it — the fingerprint + golden-fixture
  // path have no meaning without the fixture file / `archstone verify`, so strip `contract`
  // from every tool before writing.
  const stripped: IR = { ...ir, tools: ir.tools.map(({ contract: _contract, ...t }) => t) };

  const outFile = resolve(process.cwd(), outPath ?? "archstone.ir.json");
  writeFileSync(outFile, `${JSON.stringify(stripped, null, 2)}\n`);
  console.log(`archstone build ${dir} → ${outFile} (${stripped.tools.length} tool(s))`);
  process.exit(0);
}

function runServeHttp(dir: string, port: number, token: string | undefined): void {
  // Rule #7 / ADD-0008 R-5: fail closed before touching the network — a missing token is a
  // startup error, never a silently-open endpoint. `--token` wins over the env var if both
  // are set; createHttpHandler itself would also throw on empty, but checking here first
  // gives a CLI-appropriate error message instead of an uncaught exception.
  if (!token) {
    console.error(
      "archstone serve --http: bearer token required — set ARCHSTONE_HTTP_TOKEN or pass --token <value>",
    );
    process.exit(1);
  }

  const built = buildRegistry(dir);
  if (!built.ok || !built.registry) {
    console.error(`archstone: cannot serve '${dir}' — manifest invalid:`);
    for (const i of built.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of built.diagnostics.filter((x) => x.severity === "error")) console.error(`  - ${d.message}`);
    process.exit(1);
  }

  const handler = createHttpHandler(built.registry, { bearerToken: token });
  const server = createServer((req, res) => {
    void handleHttpRequest(handler, req, res);
  });
  server.listen(port, () => {
    console.error(`archstone: serving MCP over HTTP on http://localhost:${port}/ (bearer-token gated)`);
  });
}

// D-3's "~20-line wrapper": Node's http.IncomingMessage/ServerResponse <-> Web-standard
// Request/Response, so createHttpHandler (already Web-standard, shared with
// @archstone/agent/mcp's mcpHandler()) can serve real Node HTTP traffic without a second
// transport implementation. CLI-level plumbing only — HTTP itself still lives in
// providers/rest for business-backend calls; this adapter never touches a backend.
async function handleHttpRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });

  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

const HEALTH_ICON: Record<HealthStatus, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

async function runVerifyCmd(dir: string, json: boolean): Promise<void> {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const ok = res.ok && errors.length === 0;
  if (!ok) {
    if (json) {
      // ADD-20 D-2: this shape is strictly disjoint from the `{results}` shape below —
      // never add a shared "envelope" field (e.g. `ok`) to either.
      console.log(JSON.stringify({ error: "manifest_invalid", issues: res.issues, errors }));
    } else {
      console.error(`archstone verify ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    }
    process.exit(2);
  }

  const registry = new Registry(compile(res));
  const reports = await runVerify(registry.listCapabilities(), dir, registry.ir.resources);

  if (json) {
    // ADD-20 D-2: strictly disjoint from the `{error, issues, errors}` shape above.
    console.log(JSON.stringify({ results: reports }));
    process.exit(reports.some((r) => r.status === "red") ? 1 : 0);
  }

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

/** Value of a `--name value` flag pair, plus the index it was found at (-1 if absent) —
 *  used both to read the value and to exclude both tokens from the positional args. */
function flagArg(argv: string[], name: string): { value?: string; idx: number } {
  const idx = argv.indexOf(name);
  return { value: idx !== -1 ? argv[idx + 1] : undefined, idx };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const http = argv.includes("--http");
  const out = flagArg(argv, "--out");
  const port = flagArg(argv, "--port");
  const token = flagArg(argv, "--token");

  const consumed = new Set<number>();
  for (const f of [out, port, token]) {
    if (f.idx !== -1) {
      consumed.add(f.idx);
      consumed.add(f.idx + 1);
    }
  }
  const positional = argv.filter((a, i) => !consumed.has(i) && a !== "--json" && a !== "--http");
  const [cmd, dir] = positional;

  if (cmd === "apply" && dir) {
    runApply(dir);
    return;
  }
  if (cmd === "serve" && dir && http) {
    // Bearer token: --token wins over ARCHSTONE_HTTP_TOKEN if both are set (Rule #7 —
    // required, never defaults open).
    runServeHttp(dir, Number(port.value ?? 8787), token.value ?? process.env.ARCHSTONE_HTTP_TOKEN);
    return; // blocks on the HTTP server
  }
  if (cmd === "serve" && dir) {
    await serveStdio(dir); // blocks on the stdio transport
    return;
  }
  if (cmd === "verify" && dir) {
    await runVerifyCmd(dir, json);
    return;
  }
  if (cmd === "build" && dir) {
    runBuild(dir, out.value);
    return;
  }

  console.error(
    "usage: archstone <apply|serve|verify|build> <manifest-dir> [--json] [--out path]\n" +
      "       archstone serve --http <manifest-dir> [--port <n>] [--token <value>]\n" +
      "         bearer token: --token <value>, or the ARCHSTONE_HTTP_TOKEN env var (required — never serves open)",
  );
  process.exit(2);
}

main();
