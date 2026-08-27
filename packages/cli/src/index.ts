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
//         scheduled by Archstone itself (wire it into your own CI/cron). A replay IS an
//         invocation, so a `write`/`irreversible` binding is skipped by default and
//         re-included only by `--sandbox`, an assertion the operator makes (#124).
// build: run the same compile pipeline as `apply`, strip each tool's `contract`
//        (D-8 — the fingerprint/golden-fixture path is meaningless once the fixture
//        file isn't shipping), and write the IR as a standalone JSON artifact —
//        the substrate `@archstone/agent`'s `fromIR()` will consume (RFC-0008).
// init: read an existing API description, ask the human the questions no tool can answer
//        (is this a capability? is it `read`? what is it called?), and write a CDL manifest
//        the real compiler has already compiled (ADD-37). Thin by design — argv, the terminal
//        gate and report rendering only; everything of substance is in @archstone/init.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { load } from "@archstone/schema";
import { validateSemantics, compile, type IR } from "@archstone/compiler";
import { Registry, buildRegistry, serveStdio, runVerify, type HealthStatus } from "@archstone/runtime";
import { createHttpHandler } from "@archstone/runtime/http";
import { INIT_USAGE, runInitCmd } from "./init";
import { runAuditCmd } from "./audit-cmd";
import { diagnose, formatReport } from "./doctor";
import { runAdoptCmd } from "./adopt";

/** `archstone --version` is the first thing a human types after installing, and until this
 *  existed it printed the usage block and exited 2 — which reads as "broken install" at the
 *  exact moment a new user is deciding whether this thing works.
 *
 *  `../package.json` resolves correctly from BOTH layouts without a build step knowing about
 *  it: in dev the entry is `src/index.ts`, and when published it is `dist/index.js` — both sit
 *  one level under the package root. npm always ships `package.json` regardless of the `files`
 *  allowlist, so the published resolution cannot break. */
function cliVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    // Never let a version lookup be the thing that stops the CLI from running.
    return "unknown";
  }
}

/** One spelling of the usage block, shared by `--help` (stdout, exit 0 — the user asked) and by
 *  the no-verb-matched fallthrough (stderr, exit 2 — the user got it wrong). Which stream and
 *  which exit code is the ONLY difference between those two cases, and keeping the text in one
 *  place is what stops them drifting. */
function printUsage(opts?: { toStderr?: boolean }): void {
  const write = opts?.toStderr ? console.error : console.log;
  write(
    // `init` is named HERE, in the verb list, and not only in the block below it. It takes a
    // spec file rather than a manifest directory, so it cannot share the first line's shape —
    // which is exactly how it came to be missing from the one line a user actually scans.
    "usage: archstone <apply|serve|verify|build|doctor|init|adopt|audit>\n\n" +
      "       archstone <apply|serve|verify|build> <manifest-dir> [--json] [--out path]\n" +
      "       archstone verify <manifest-dir> [--json] [--sandbox]\n" +
      "         --sandbox: also replay `write`/`irreversible` fixtures — they are skipped by default,\n" +
      "         because a replay is a real invocation. Only for a backend you know is a sandbox tenant.\n" +
      "       archstone serve --http <manifest-dir> [--port <n>] [--token <value>]\n" +
      "         bearer token: --token <value>, or the ARCHSTONE_HTTP_TOKEN env var (required — never serves open)\n" +
      "       archstone doctor <manifest-dir> [--json]  — pre-production checks, offline\n" +
      "       archstone init <spec-file> --out <dir>   — start here if you have no manifest yet\n" +
      "       archstone adopt <manifest-dir>\n" +
      "         declare a field the backend started returning; asks before writing, needs a person\n\n" +
      "       archstone audit <file...> [--since <date>] [--format summary|jsonl|csv]\n" +
      "         read your own Execution audit records; nothing is uploaded (audit --help for filters)\n\n" +
      "       archstone --version | --help\n\n" +
      INIT_USAGE,
  );
}

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
 * Bounds on the "lingering close" that `refuseOversizedBody` performs: how many bytes of an
 * already-refused body are read and thrown away, and how long the socket is kept around, before
 * the client is cut off for good.
 *
 * Both exist to bound a courtesy, not a capability. Nothing here is ever buffered — the bytes
 * are discarded as they arrive and `chunks` is emptied the moment the cap trips — so the
 * allocation bound #50 established is untouched. What is being spent is socket time on a client
 * that already misbehaved, so it is capped rather than run to completion.
 */
const MAX_REFUSED_BODY_DRAIN_BYTES = 64 * 1024 * 1024;
const REFUSED_BODY_LINGER_MS = 5_000;

/**
 * Refuse an oversized body with a 413 the client will actually receive, then let go of the
 * socket.
 *
 * Refusing turned out not to be the same as being heard. Ending the response the ordinary way
 * sets `Connection: close`, and Node then calls `destroySoon()` as soon as the response has
 * flushed — without waiting on the read side. The client is still mid-upload, so megabytes of
 * its body are sitting unread in this process's receive buffer, and a socket closed with unread
 * data does not send FIN, it sends RST. An RST makes the peer's stack DISCARD whatever is
 * already in its own receive buffer — the just-delivered 413 included. Measured against the
 * real CLI: 7 of 25 chunked oversize uploads ended in ECONNRESET/EPIPE with the response
 * destroyed in flight, and the rate climbed with machine load. The caller could not tell "your
 * body is too large" apart from "the server fell over" (measured 2026-08-26).
 *
 * Draining the body before closing is the obvious repair and it is not enough: under load the
 * event loop drains slower than the client fills, so the buffer is still dirty at close. It cut
 * the loss from 7/25 to 3/40 idle, and it was still 8/40 at load average 44.
 *
 * What is sufficient is to never call close() with the read side dirty. So the socket is taken
 * over from the response, the 413 is written by hand, and `socket.end()` issues a bare
 * shutdown(WR): the response and the FIN leave together, the read side stays open, and no RST
 * is ever generated. The remaining upload is then read and dropped until the client gives up,
 * the byte budget is spent, or the linger expires. This is nginx's `lingering_close`, and it is
 * why the caller may go on streaming without ever costing this process memory. Measured on the
 * same machine at load average 44: 60 of 60 uploads received their 413, including the
 * pathological client that never stops writing and never terminates its chunked body.
 *
 * Both refusal paths use this — the streaming guard and the declared-Content-Length fast path.
 * The fast path still decides on the header alone, before reading a byte; lingering afterwards
 * does not change what the decision was made from, only whether the caller gets to hear it.
 *
 * What this does NOT add is a cap on how many sockets may be lingering at once. Stated out
 * loud rather than left implicit, because #49/#50 treated this file's unauthenticated surface
 * carefully: a flood can now hold a refused connection for up to the bounds above where it
 * used to be dropped near-instantly. The exposure is file descriptors and time, never memory,
 * and it is what buys a caller the ability to learn why it was refused. If a global cap is
 * ever wanted it belongs at the server, alongside `maxConnections`, not here.
 *
 * Writing the status line by hand is deliberate. `res.detachSocket()` is the supported way to
 * take a socket out of Node's response machinery (it is what an HTTP upgrade does), and once
 * detached the ServerResponse must not be used — it no longer owns anything to write through.
 */
function refuseOversizedBody(res: ServerResponse): void {
  const socket = res.socket;
  // No socket to linger on, or the response is already committed: fall back to the ordinary
  // ending. It may be lost to an RST, which is strictly better than throwing from here (#49).
  if (!socket || res.headersSent || res.writableEnded || res.destroyed || socket.destroyed) {
    endResponseQuietly(res, 413, { closeConnection: true });
    return;
  }
  try {
    res.detachSocket(socket);
    // No `Date`, which Node's ServerResponse would have added. Deliberate, and the only header
    // that differs from the old path: RFC 9110 recommends rather than requires it, and this
    // connection closes immediately, so nothing downstream can cache or age the response.
    socket.write("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.end(); // shutdown(WR) only — the read side deliberately stays open.

    let discarded = 0;
    socket.on("data", (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > MAX_REFUSED_BODY_DRAIN_BYTES) socket.destroy();
    });
    socket.resume();
    // Client faults are never logged (#49 BF-1) and a dead peer must not leak a socket, so the
    // two remaining exits are silent: the budget above, and this deadline.
    socket.on("error", () => socket.destroy());
    const linger = setTimeout(() => socket.destroy(), REFUSED_BODY_LINGER_MS);
    linger.unref();
    socket.on("close", () => clearTimeout(linger));
  } catch {
    // The socket went away between the guard above and the write. Nothing to say, no one to
    // say it to — same contract as endResponseQuietly.
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

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
    // Refused on the header, without reading a byte — then handed to the same lingering close
    // as the streaming guard below. Which bytes the SERVER chose to read is not what decides
    // whether the 413 survives: the RST is triggered by bytes sitting unread in the KERNEL
    // receive buffer when the write side closes, and a client that declares N and then sends N
    // — i.e. every real HTTP library — puts them there whether or not this function ever
    // looked. Measured on a warm server: 18/25 of these lost their 413 before this line
    // changed. (A fresh server loses none, which is why the test suite never caught it.)
    refuseOversizedBody(res);
    return;
  }

  const chunks: Buffer[] = [];
  try {
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        // Nothing downstream will ever read these; drop them before handing the socket over.
        chunks.length = 0;
        // Takes the socket out of `res` and answers on it directly, so returning here (which
        // tears the request stream down) can no longer cost the client its 413.
        refuseOversizedBody(res);
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

/** #124: deliberately NOT one of `HEALTH_ICON`'s three. A skipped binding was never inspected,
 *  so it must not be scannable as a colour — no colour is earned (ADD-124 D-2). */
const SKIP_ICON = "⏭";

/**
 * #124 / ADD-124 D-13 — printed once, only when something was skipped, and only to a human.
 *
 * It names the PATTERN and never a capability id: nothing in CDL or the IR links a `write`
 * capability to its `read` counterpart (`examples/manifests/bank`'s
 * `initiate-transfer`/`quote-transfer` pair is naming convention, not a declared relationship),
 * so guessing one would sometimes name the wrong capability with the same confidence as the
 * right one — worse than naming none (D-11). Same hedge as `doctor.ts`'s `no-contract-non-read`
 * advisory ("Not every write has one…") — these two must not drift apart.
 */
const READ_TWIN_TIP =
  "  Where one of these has a `read` capability against the same backend — the quote half of a\n" +
  "  quote → commit pair — verifying that instead hits the same host, auth and serialization,\n" +
  "  catching most infrastructure and schema drift at zero risk. Not every write has one, and\n" +
  "  Archstone cannot tell you which capability it is: nothing in CDL declares that relationship.\n" +
  "  If this backend really is a sandbox tenant, pass --sandbox.";

async function runVerifyCmd(dir: string, json: boolean, sandbox: boolean): Promise<void> {
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
  // Two literal call sites rather than one with a computed 5th argument (#124 / ADD-124 D-3).
  // The DEFAULT path — what CI and every non-sandbox operator runs — stays the exact
  // three-argument form the two CLI surface tests pin: no `InvokeOptions` bag at all, so no
  // audit sink and no per-response callback can reach it. The `--sandbox` path passes an
  // explicit `undefined` in that slot for the same reason, so the scope argument can never be
  // the reason such a bag starts being constructed here.
  const { results, skipped } = sandbox
    ? await runVerify(registry.listCapabilities(), dir, registry.ir.resources, undefined, { includeNonRead: true })
    : await runVerify(registry.listCapabilities(), dir, registry.ir.resources);

  // ADD-124 D-6: computed from `results` ONLY, exactly as before. A skip never fails the gate —
  // an all-skipped run exits 0, the same code an all-empty run already produced. Inventing a
  // failure mode for "every write/irreversible binding correctly declined to replay itself"
  // would punish the manifests doing the safe, default thing.
  const exitCode = results.some((r) => r.status === "red") ? 1 : 0;

  if (json) {
    // ADD-20 D-2: strictly disjoint from the `{error, issues, errors}` shape above.
    //
    // `skipped` and `sandbox` are ADDITIVE (ADD-124 D-7). A consumer filtering `results` for red
    // is unaffected: skipped bindings were never in `results` to begin with. `sandbox` records
    // HOW verify was invoked, so a dashboard can tell "nothing dangerous was replayed" from
    // "everything was replayed because someone asserted a sandbox".
    console.log(JSON.stringify({ results, skipped, sandbox }));
    process.exit(exitCode);
  }

  console.log(`\narchstone verify ${dir}\n`);
  if (results.length === 0 && skipped.length === 0) {
    console.log("  (no bindings declare a contract: — nothing to verify)\n");
    process.exit(0);
  }
  for (const r of results) {
    console.log(`  ${HEALTH_ICON[r.status]} ${r.capabilityId} — ${r.detail}`);
  }
  for (const s of skipped) {
    console.log(`  ${SKIP_ICON} ${s.capabilityId} — ${s.detail}`);
  }
  if (skipped.length > 0) {
    console.log(`\n  ${skipped.length} binding(s) were NOT verified against the backend.`);
    console.log(READ_TWIN_TIP);
  }
  console.log("");
  process.exit(exitCode);
}

/** Value of a `--name value` flag pair, plus the index it was found at (-1 if absent) —
 *  used both to read the value and to exclude both tokens from the positional args. */
function flagArg(argv: string[], name: string): { value?: string; idx: number } {
  const idx = argv.indexOf(name);
  return { value: idx !== -1 ? argv[idx + 1] : undefined, idx };
}

/**
 * #102 — A-7 §5's pre-production checklist, run instead of read. Offline by construction: it
 * compiles the manifest and inspects the IR plus what sits beside it on disk. Nothing is
 * invoked and no backend is contacted — that is `verify`, and this is the question you ask
 * before pointing anything at production.
 */
function runDoctor(dir: string, json: boolean): void {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  if (!res.ok || errors.length > 0) {
    console.error(`archstone doctor ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    process.exit(1);
  }

  const ir = compile(res);
  // Compare drift against what `build` would actually write, which strips `contract` (ADD-43
  // D-9's strip rule) — comparing against the unstripped IR would report drift on every
  // manifest that records a fixture, i.e. on every well-configured one.
  const stripped: IR = { ...ir, tools: ir.tools.map(({ contract: _contract, ...t }) => t) };
  const report = diagnose(ir, dir, { builtIr: `${JSON.stringify(stripped, null, 2)}\n` });

  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report, dir));
  process.exit(report.ok ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Before anything else: `--version`/`-V` and `--help`/`-h` are what a human types first, and
  // both used to fall through to the usage block with exit 2 — a non-zero exit for a question
  // that was answered correctly. Both now exit 0. `-V` is capitalised because `-v` is verbose
  // by long convention and should stay free.
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(cliVersion());
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  const json = argv.includes("--json");
  const http = argv.includes("--http");
  // #124: boolean, takes no argument. NOT `--force`/`--yes`: those read as overriding a check
  // Archstone performed, and the honest situation is the opposite — Archstone performed no check
  // and structurally cannot (`doctor`'s own `env-baseurl` advisory already concedes that the
  // deployment, not the manifest, decides where `${VAR}` points). `--sandbox` is the operator
  // supplying the one fact only they hold. It takes no target string because a target would
  // imply Archstone validates it against something, and there is nothing to validate against.
  const sandbox = argv.includes("--sandbox");
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
  const positional = argv.filter((a, i) => !consumed.has(i) && a !== "--json" && a !== "--http" && a !== "--sandbox");
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
    await runVerifyCmd(dir, json, sandbox);
    return;
  }
  if (cmd === "build" && dir) {
    runBuild(dir, out.value);
    return;
  }
  if (cmd === "doctor" && dir) {
    runDoctor(dir, json);
    return;
  }
  if (cmd === "adopt") {
    // Its own parser, and its own module: it is the only verb that WRITES a manifest a human
    // already owns, so keeping it apart from the read-only verbs above is deliberate.
    process.exit(await runAdoptCmd(argv));
  }
  if (cmd === "audit") {
    // Own parser, for the same reason `init` has one: this verb's flags outnumber the other
    // verbs' put together, and threading them through the positional logic above would make
    // both harder to read.
    process.exit(runAuditCmd(argv));
  }
  if (cmd === "init") {
    // Everything `init` needs is in its own argv parser: it has more flags than the other four
    // verbs put together, and threading them through this function's positional logic would
    // make both harder to read.
    process.exit(await runInitCmd(argv));
  }

  printUsage({ toStderr: true });
  process.exit(2);
}

main();
