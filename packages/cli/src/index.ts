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
  // #43: a policy the author believes is enforced must never be invisible here — the whole
  // point of the semantic pass's scope diagnostics is that "attached to nothing" is loud.
  if (res.policyDocs.length > 0) {
    console.log(`  policies   ${res.policyDocs.length} policy document(s)`);
    for (const p of res.policyDocs) {
      const target =
        p.metadata.scope === "capability"
          ? `capability ${p.metadata.capabilityId ?? "?"}`
          : p.metadata.scope === "provider"
            ? `provider ${p.metadata.provider ?? "?"}`
            : "(no scope)";
      console.log(`    ✓ ${p.metadata.id}  → ${target}`);
    }
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

  const shapesAndSemanticsOk = res.ok && errors.length === 0;

  // Compile to IR (#4) + index into the Registry (#5) — only when valid enough to emit.
  // ADD-30: a tool-name collision (two capability ids sanitizing to the same advertised
  // name) is checked here, before the final `ok`, alongside the semantic errors above —
  // 'apply' must refuse the same manifest 'build'/'serve' would refuse (D-2).
  const registry = shapesAndSemanticsOk ? new Registry(compile(res)) : undefined;
  const collisions = registry?.toolNameCollisions ?? [];
  if (collisions.length > 0) {
    console.log(`\n  ✗ ${collisions.length} tool-name collision(s):`);
    for (const c of collisions) {
      console.log(`    - tool name '${c.name}' is ambiguous — capabilities ${c.ids.join(", ")} all sanitize to it`);
    }
  }

  const ok = shapesAndSemanticsOk && collisions.length === 0;

  if (ok && registry) {
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

  // ADD-30 R-2: `runBuild` didn't construct a Registry at all, so it could ship a broken
  // artifact whose ambiguous tool name only surfaces later, inside a third party's
  // `fromIR()` call. Refuse to write on a collision — fail at `build` time instead
  // (the same "ambiguous is a compile-time error, never a guess" pattern this repo already
  // applies to resource-name resolution, compiler/src/resolve.ts).
  const registry = new Registry(ir);
  if (registry.toolNameCollisions.length > 0) {
    console.error(`archstone build ${dir}: refusing to write artifact — tool-name collision(s):`);
    for (const c of registry.toolNameCollisions) {
      console.error(`  - tool name '${c.name}' is ambiguous — capabilities ${c.ids.join(", ")} all sanitize to it`);
    }
    process.exit(1);
  }

  // THE STRIP RULE, stated as a principle rather than a list (ADD-43 D-9), so the next field
  // added to `IRTool` is classified deliberately instead of by whichever example was copied:
  //
  //     strip what the INVOCATION PATH cannot use.
  //
  // `contract` qualifies (ADD-0008 D-8): it is verify-time-only and carries an fs path that is
  // meaningless once the golden fixture is not shipping alongside the artifact.
  //
  // `policyRules` (#43) is the exact opposite and MUST survive: it is invocation-path data, read
  // by the evaluator on every `execute()` call. Stripping it would ship an unpoliced embedded
  // SDK beside a policed MCP surface — the precise cross-path drift #43 exists to prevent, and
  // silent, because `fromIR` validates only `version` and treats the rest as opaque.
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
    // #49 belt-and-braces: this used to be `void handleHttpRequest(...)`. Fire-and-forget
    // means nothing is attached to the returned promise, so ANY rejection escaping the
    // function became an unhandled rejection — fatal under Node's default
    // `--unhandled-rejections=throw`, killing the server on one aborted client connection.
    // handleHttpRequest now contains its own failures, but this `.catch` is the seam that
    // makes the fix independent of that catch staying exhaustive: a future throw added
    // outside its `try` cannot resurrect the process-death bug.
    handleHttpRequest(handler, req, res).catch((err: unknown) => {
      console.error("archstone serve --http: request handling failed —", err);
      endResponseQuietly(res, 500);
    });
  });
  server.listen(port, () => {
    console.error(`archstone: serving MCP over HTTP on http://localhost:${port}/ (bearer-token gated)`);
  });
}

/**
 * Largest request body `archstone serve --http` will buffer, in bytes (#50).
 *
 * 4 MiB is not chosen by feel: it is the limit the MCP SDK itself applies to an MCP message
 * arriving over HTTP (`MAXIMUM_MESSAGE_SIZE = '4mb'` in the SDK's own Node SSE transport,
 * enforced via `raw-body`). Same protocol, same message class, same SDK version this package
 * already depends on — so the ceiling matches what an MCP client can reasonably expect to send
 * anywhere else in the ecosystem, rather than inventing an Archstone-specific number. The
 * Web-standard transport used here never reads the socket itself (this adapter hands it an
 * already-built `Request`), which is precisely why the SDK's limit does not apply on this path
 * and has to be reapplied here.
 *
 * For scale: an MCP `tools/call` body carries a capability's declared inputs as JSON. 4 MiB is
 * orders of magnitude above any manifest in `examples/`.
 */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Terminate a response without ever throwing (#49). Every exit path out of the adapter goes
 * through here, including the ones reached after the client is already gone: on an aborted
 * connection the socket is destroyed, and a naive `res.end()` there is at best pointless and
 * at worst a second error thrown out of an error path. Ending is still attempted whenever the
 * socket survives — a truncated body on a keep-alive connection has a live socket that would
 * otherwise hang until the client's own timeout.
 */
function endResponseQuietly(
  res: ServerResponse,
  status: number,
  opts: { closeConnection?: boolean } = {},
): void {
  try {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.statusCode = status;
      // #50: on a refused oversized body the connection must not be reused. The client is
      // mid-upload and the rest of its bytes are still in flight, so a keep-alive socket
      // would leave that remainder to be misparsed as the next request. `Connection: close`
      // lets Node flush the response first and then close — destroying the socket here
      // instead would race the 413 and the client would see nothing.
      if (opts.closeConnection) res.setHeader("connection", "close");
    }
    res.end();
  } catch {
    // The socket went away between the checks above and the write. Nothing is left to
    // terminate and there is no one to tell — swallowing here is the whole point.
  }
}

// D-3's "~20-line wrapper": Node's http.IncomingMessage/ServerResponse <-> Web-standard
// Request/Response, so createHttpHandler (already Web-standard, shared with
// @archstone/agent/mcp's mcpHandler()) can serve real Node HTTP traffic without a second
// transport implementation. CLI-level plumbing only — HTTP itself still lives in
// providers/rest for business-backend calls; this adapter never touches a backend.
//
// #49 (P0, unauthenticated remote DoS): this function must never reject and must always
// reach a terminal `res.end()`. It is invoked from a Node `request` listener, where an
// escaping rejection is an unhandled rejection and therefore a fatal uncaught exception —
// one client that declares a Content-Length and disconnects mid-body used to kill the
// process, before any handler and therefore before any credential check ran.
async function handleHttpRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // #50: the body is buffered BEFORE authentication (the bearer check lives inside
  // createHttpHandler, reached only once the Request is built), so an unauthenticated client
  // controls how much memory this allocates. Measured server-side: the body is held ~4x over
  // simultaneously — the chunk array, `Buffer.concat`'s copy, and undici's own copies inside
  // `new Request` — so a 256 MiB body peaked at 1,081 MiB RSS, essentially all of it in
  // `external`/`arrayBuffers`. Being external is what makes it nasty: `--max-old-space-size`
  // does not bound it, and the terminal symptom is an uncatchable OOM abort.
  //
  // A declared Content-Length over the cap is refused before a single byte is read; the
  // running total is then enforced during streaming as well, because Content-Length can lie
  // and chunked encoding omits it entirely. Like every other client fault in this adapter the
  // 413 is NOT logged — an unauthenticated caller must not be able to drive log volume (#49
  // BF-1).
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    endResponseQuietly(res, 413, { closeConnection: true });
    return;
  }

  const chunks: Buffer[] = [];
  try {
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        // Returning from inside `for await` calls the iterator's `return()`, which tears the
        // request stream down — so the remaining bytes are never buffered, and the client is
        // not left streaming into a socket nobody drains.
        endResponseQuietly(res, 413, { closeConnection: true });
        return;
      }
      chunks.push(buf);
    }
  } catch {
    // The client went away mid-body (ECONNRESET / aborted), or delivered fewer bytes than
    // its declared Content-Length. On a public endpoint this is routine traffic — a closed
    // laptop, a cancelled fetch, a load-balancer health probe — NOT a server fault, so it is
    // deliberately not logged: turning an aborted-request flood into a log flood just trades
    // one denial of service for another.
    //
    // 400 is the deliberate status, not 500: the request was never completed, and nothing on
    // the server failed. In practice nobody reads it — this catch is reached only once the
    // socket is already dead. (Node does NOT surface a short body while the connection is
    // still open: it waits for the declared bytes until `server.requestTimeout`, 300 s by
    // default, and answers that itself.) The end is still attempted rather than skipped
    // because this code cannot tell from here whether `res` is writable — `req` erroring
    // does not by itself prove the response side is gone — and `endResponseQuietly` makes
    // the attempt free when it is.
    endResponseQuietly(res, 400);
    return;
  }

  // Translating the raw request into a Web `Request` is still CLIENT input handling, and it
  // runs BEFORE authentication (the bearer check lives inside createHttpHandler, reached only
  // at `handler(request)` below). `req.headers.host` and `req.url` are attacker-controlled and
  // a malformed value throws here — a bad `Host` was in fact a second unauthenticated kill
  // vector before #49's containment landed. So this gets its own client-fault arm, on exactly
  // the argument the body-read catch above makes: answering 500 and logging a stack trace per
  // request would hand an unauthenticated caller ~13x log amplification and trade the crash
  // for a disk-fill DoS. RFC 9112 §3.2 also makes 400 the required answer to an invalid Host.
  //
  // Classification is positional, not by error sniffing: what failed decides the class, so it
  // cannot drift when undici changes an error's shape between Node versions.
  let request: Request;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
  } catch {
    endResponseQuietly(res, 400);
    return;
  }

  try {
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (err) {
    // A genuine server-side failure: the handler rejected, or serialising its Response threw.
    // Unlike a malformed or abandoned request this IS worth surfacing, so it is logged — and
    // answered with a 500 rather than left to hang the caller. Nothing attacker-controlled
    // reaches this arm without first passing through the handler, so it cannot be used as a
    // log-amplification primitive the way the pre-auth construction path above could.
    console.error("archstone serve --http: request handling failed —", err);
    endResponseQuietly(res, 500);
  }
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
