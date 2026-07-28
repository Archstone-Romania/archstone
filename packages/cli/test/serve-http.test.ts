import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

// `archstone serve --http` end to end (ADD-0008 #29): spawn the real CLI, wait for it to
// bind, then drive it with real HTTP requests (fetch) — no Workers runtime, no mock
// transport. Covers the bearer-token gate (missing/wrong -> 401, no tool leakage) and a real
// initialize -> tools/list round trip. Complements packages/agent/test/mcp.test.ts (which
// exercises mcpHandler()/createHttpHandler directly, in-process) by proving the CLI's
// Node-http adapter (the "~20-line wrapper", D-3) actually works over a real socket.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");

// A per-test-run port, not a fixed one, to keep repeated/parallel runs from colliding.
const PORT = 20000 + (process.pid % 10000);
const BASE = `http://localhost:${PORT}/`;

let child: ChildProcess | undefined;

function startServeHttp(env: Record<string, string | undefined>): Promise<void> {
  return new Promise((res, rej) => {
    child = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT)], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let out = "";
    const onData = (d: Buffer) => {
      out += String(d);
      if (out.includes("serving MCP over HTTP")) {
        child?.stderr?.off("data", onData);
        res();
      }
    };
    child.stderr?.on("data", onData);
    child.on("error", rej);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) rej(new Error(`archstone serve --http exited early (code ${code}): ${out}`));
    });
  });
}

afterEach(() => {
  child?.kill();
  child = undefined;
});

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("archstone serve --http (ADD-0008 #29)", () => {
  it("401s without a bearer token, with no tool information in the body", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const res = await mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/tourism_search/);
  }, 20000);

  it("401s with the wrong bearer token", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const res = await mcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { authorization: "Bearer wrong" },
    );
    expect(res.status).toBe(401);
  }, 20000);

  it("initialize -> tools/list, with a valid bearer token (ARCHSTONE_HTTP_TOKEN)", async () => {
    await startServeHttp({ ARCHSTONE_HTTP_TOKEN: "demo-secret" });
    const auth = { authorization: "Bearer demo-secret" };

    const init = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
      },
      auth,
    );
    expect(init.status).toBe(200);

    const list = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result?: { tools: { name: string }[] } };
    expect(body.result?.tools.map((t) => t.name)).toContain("tourism_search");
  }, 20000);

  it("a --token flag is accepted in place of the env var", async () => {
    child = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT + 1), "--token", "flag-secret"], {
      cwd: root,
      env: process.env,
    });
    await new Promise<void>((res, rej) => {
      let out = "";
      const onData = (d: Buffer) => {
        out += String(d);
        if (out.includes("serving MCP over HTTP")) {
          child?.stderr?.off("data", onData);
          res();
        }
      };
      child?.stderr?.on("data", onData);
      child?.on("error", rej);
    });
    const res = await fetch(`http://localhost:${PORT + 1}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer flag-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  }, 20000);
});

// #49 (P0, unauthenticated remote DoS). One TCP connection used to kill the process: declare
// a Content-Length, send less than that, disconnect. `for await (const chunk of req)` rejected
// with ECONNRESET inside a fire-and-forget `void handleHttpRequest(...)`, which Node's default
// `--unhandled-rejections=throw` promoted to a fatal uncaught exception. The abort lands while
// the body is read — before the handler, and therefore before the Authorization check — so no
// credentials were needed.
//
// A second, simpler vector found in review and not recorded in #49: a single request with a
// malformed `Host` (`curl -H 'Host: ['`) threw ERR_INVALID_URL out of the same function and
// killed the process the same way — no body games, no timing. Both are pre-authentication.
//
// The assertion that matters is LIVENESS, not a status code. A test that only checked the
// response would not have caught this: the aborting client never reads a response, and the
// symptom is process death. For the Host vector the second assertion with teeth is stderr
// BYTE GROWTH — the first fix contained the crash but answered 500 and logged a stack trace
// per unauthenticated request, converting the crash into a log-flood DoS.

interface ServeProc {
  /** Everything the server has written to stderr, including the startup banner. */
  stderr: () => string;
  /** False once the process has exited or been signalled — the #49 symptom. */
  alive: () => boolean;
}

function startServeOn(port: number, token: string): Promise<ServeProc> {
  return new Promise((res, rej) => {
    const proc = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(port), "--token", token], {
      cwd: root,
      env: process.env,
    });
    child = proc;
    let out = "";
    let settled = false;
    // Unlike startServeHttp above, this listener is deliberately NOT removed once the banner
    // appears: these tests assert on what the server logs AFTER boot, so stderr has to keep
    // accumulating. The `settled` guard gives the same resolve-once semantics without it.
    proc.stderr?.on("data", (d: Buffer) => {
      out += String(d);
      if (!settled && out.includes("serving MCP over HTTP")) {
        settled = true;
        res({ stderr: () => out, alive: () => proc.exitCode === null && proc.signalCode === null });
      }
    });
    proc.on("error", rej);
    // Fail fast with the captured stderr instead of hanging to the test timeout when the
    // server never binds (port already in use, invalid manifest, …).
    proc.on("exit", (code) => {
      if (!settled) rej(new Error(`archstone serve --http exited early (code ${code}): ${out}`));
    });
  });
}

/** The exact repro from #49: a raw socket that promises 500 body bytes, sends 6, then vanishes. */
function abortMidBody(port: number, extraHeaders = ""): Promise<void> {
  return new Promise((done) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
          `${extraHeaders}Content-Length: 500\r\n\r\n`,
      );
      s.write('{"a":1'); // far short of the declared 500
      setTimeout(() => {
        s.destroy();
        done();
      }, 200);
    });
    s.on("error", () => done());
  });
}

/**
 * One raw, UNAUTHENTICATED request with an attacker-supplied `Host`, resolving to the status
 * line. `fetch` cannot express this — undici validates `Host` client-side — so it has to be a
 * socket. Pre-#49 this killed the process on the first request; between the first fix and the
 * BF-1 fix it answered 500 and wrote a ~786-byte stack trace to stderr per request.
 */
function malformedHostRequest(port: number, host: string): Promise<string> {
  return new Promise((done) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    s.on("data", (d: Buffer) => (buf += String(d)));
    s.on("close", () => done(buf.split("\r\n")[0] || "(no response)"));
    s.on("error", () => done("(socket error)"));
    setTimeout(() => {
      s.destroy();
      done(buf.split("\r\n")[0] || "(no response)");
    }, 3000);
  });
}

function toolsList(port: number, token: string): Promise<Response> {
  return fetch(`http://localhost:${port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("archstone serve --http — aborted request containment (#49)", () => {
  it("survives a mid-body client abort and still answers the next request", async () => {
    const port = PORT + 3;
    const server = await startServeOn(port, "probe");

    // No credentials at all — this is the unauthenticated path the P0 is about.
    await abortMidBody(port);
    // And again WITH a bearer header, to pin down that the fix is not auth-dependent
    // (#49 verified both; the abort happens before the Authorization check either way).
    await abortMidBody(port, "Authorization: Bearer probe\r\n");
    await new Promise((r) => setTimeout(r, 300));

    // Liveness first: process death, not a status code, is the defect.
    expect(server.alive()).toBe(true);

    const res = await toolsList(port, "probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools: { name: string }[] } };
    expect(body.result?.tools.map((t) => t.name)).toContain("tourism_search");
  }, 30000);

  it("does not log a routine client disconnect as a server error", async () => {
    const port = PORT + 4;
    const server = await startServeOn(port, "probe");

    for (let i = 0; i < 5; i++) await abortMidBody(port);
    await new Promise((r) => setTimeout(r, 300));

    expect(server.alive()).toBe(true);
    // Containment must not become a log flood: an aborted-request storm would otherwise
    // just trade one denial of service for another. Nothing beyond the startup banner.
    const beyondBanner = server.stderr().replace(/^archstone: serving MCP over HTTP.*$/m, "").trim();
    expect(beyondBanner).toBe("");
  }, 30000);

  it("answers an unauthenticated malformed Host with 400 and logs nothing (BF-1)", async () => {
    const port = PORT + 5;
    const server = await startServeOn(port, "probe");
    const banner = server.stderr().length;

    // Every one of these is unauthenticated — no Authorization header anywhere. `Host` and
    // the request target are read while building the Web Request, which happens BEFORE the
    // bearer check inside createHttpHandler, so the token gate cannot shield this path.
    for (const host of ["[not a host]", "a b", "%", "[", "::1]", ""]) {
      expect(await malformedHostRequest(port, host)).toContain("400");
    }

    // The amplification assertion. At 500 + stack trace this was ~786 B of stderr per ~60 B
    // request — a disk-fill DoS from the same single unauthenticated socket. A status-only
    // test would pass on the flooding version, so the byte count is the assertion with teeth.
    for (let i = 0; i < 200; i++) await malformedHostRequest(port, "[not a host]");
    await new Promise((r) => setTimeout(r, 300));

    expect(server.alive()).toBe(true);
    expect(server.stderr().length - banner).toBe(0);

    const good = await toolsList(port, "probe");
    expect(good.status).toBe(200);
  }, 60000);
});

/**
 * Stream a body far larger than MAX_REQUEST_BODY_BYTES, resolving to the status line.
 *
 * `framing` is the whole point. With `declared`, a `Content-Length` states the size up front
 * and the cap can refuse before reading a byte. With `chunked` there is no declared size at
 * all, so the guard has to hold *during* the read — which is exactly the case a cap
 * implemented as a header check would pass the first test and fail here.
 */
function oversizedBody(port: number, framing: "declared" | "chunked"): Promise<string> {
  const CAP = 4 * 1024 * 1024;
  const total = CAP * 4;
  return new Promise((done) => {
    let settled = false;
    const finish = (line: string): void => {
      if (settled) return;
      settled = true;
      done(line);
    };
    const s = net.connect(port, "127.0.0.1", () => {
      // Unauthenticated on purpose: the body is buffered before createHttpHandler's bearer
      // check, so the token gate cannot shield this path (same reason as BF-1 above).
      s.write(
        framing === "declared"
          ? `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${total}\r\n\r\n`
          : "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
      );
      const mb = Buffer.alloc(1024 * 1024, 0x41);
      const chunk =
        framing === "chunked"
          ? Buffer.concat([Buffer.from(`${(1024 * 1024).toString(16)}\r\n`), mb, Buffer.from("\r\n")])
          : mb;
      let sent = 0;
      const pump = (): void => {
        while (sent < total && !settled) {
          sent += mb.length;
          if (!s.write(chunk)) {
            s.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += String(d);
      // Stop pumping as soon as the server has answered — it should not have waited for
      // the whole upload, and continuing to write only races the socket teardown.
      if (buf.includes("\r\n")) {
        finish(buf.split("\r\n")[0]);
        s.destroy();
      }
    });
    s.on("close", () => finish(buf.split("\r\n")[0] || "(no response)"));
    // EPIPE is the expected outcome of a server that refused and closed mid-upload.
    s.on("error", () => finish(buf.split("\r\n")[0] || "(socket error)"));
    setTimeout(() => {
      s.destroy();
      finish(buf.split("\r\n")[0] || "(no response)");
    }, 20000);
  });
}

/**
 * Declares a body far over the cap but sends only a token amount of it. Isolates the
 * Content-Length fast path: too few bytes arrive for the streaming guard to fire, so any
 * refusal must have come from the header check.
 */
function declaredOversizeShortBody(port: number): Promise<string> {
  return new Promise((done) => {
    let settled = false;
    const finish = (line: string): void => {
      if (settled) return;
      settled = true;
      done(line);
    };
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
          `Content-Length: ${100 * 1024 * 1024}\r\n\r\n`,
      );
      s.write(Buffer.alloc(1024, 0x41)); // 1 KiB — nowhere near the 4 MiB streaming threshold
    });
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += String(d);
      if (buf.includes("\r\n")) {
        finish(buf.split("\r\n")[0]);
        s.destroy();
      }
    });
    s.on("close", () => finish(buf.split("\r\n")[0] || "(no response)"));
    s.on("error", () => finish(buf.split("\r\n")[0] || "(socket error)"));
    setTimeout(() => {
      s.destroy();
      finish(buf.split("\r\n")[0] || "(no response)");
    }, 10000);
  });
}

describe("archstone serve --http — request body size cap (#50)", () => {
  it("refuses an oversized body with 413 whether or not its size is declared", async () => {
    const port = PORT + 6;
    const server = await startServeOn(port, "probe");
    const banner = server.stderr().length;

    // Declared: the cap can reject on the header, before a byte is read.
    expect(await oversizedBody(port, "declared")).toContain("413");
    // Chunked: no declared size. A header-only cap passes the case above and fails this one,
    // leaving the unauthenticated unbounded-allocation path wide open.
    expect(await oversizedBody(port, "chunked")).toContain("413");

    await new Promise((r) => setTimeout(r, 300));
    expect(server.alive()).toBe(true);
    // A refused oversize body is a client fault, so it must stay unlogged for the same
    // reason BF-1 does: an amplification primitive is not a fix.
    expect(server.stderr().length - banner).toBe(0);

    const good = await toolsList(port, "probe");
    expect(good.status).toBe(200);
  }, 90000);

  it("refuses a declared oversize on the header alone, without reading the body", async () => {
    const port = PORT + 8;
    const server = await startServeOn(port, "probe");

    // Declares 100 MiB and then sends 1 KiB. The streaming guard cannot answer this — it only
    // fires past 4 MiB received, and 4 MiB never arrives — so a 413 here can only have come
    // from the Content-Length fast path. Without this the two tests above pass with the fast
    // path deleted, since the streaming guard alone satisfies them; verified by disabling it.
    const line = await declaredOversizeShortBody(port);
    expect(line).toContain("413");

    expect(server.alive()).toBe(true);
    const good = await toolsList(port, "probe");
    expect(good.status).toBe(200);
  }, 60000);

  it("still accepts a body under the cap (negative control)", async () => {
    const port = PORT + 7;
    const server = await startServeOn(port, "probe");

    // Without this, a cap that rejected everything would pass the test above. ~1 MiB of
    // padding inside a valid tools/call keeps it well under the 4 MiB ceiling.
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer probe",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tourism_search", arguments: { destination: "x".repeat(1024 * 1024) } },
      }),
    });

    expect(res.status).not.toBe(413);
    expect(server.alive()).toBe(true);
  }, 60000);
});

// NOT part of the containment regression above: this passes both before and after #49's fix.
// It pins MCP-SDK transport behaviour that #49 asserted (wrongly) was a second unguarded
// rejection source — the transport resolves malformed input to a status rather than rejecting.
// Kept because an SDK upgrade that started rejecting here would silently change which arm of
// handleHttpRequest runs, but it guards the dependency, not this fix.
describe("archstone serve --http — MCP transport characterization (SDK behaviour, not a #49 guard)", () => {
  it("answers a malformed JSON-RPC body with a 400 and keeps serving", async () => {
    const port = PORT + 6;
    const server = await startServeOn(port, "probe");

    const bad = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer probe",
      },
      body: '{"a":1',
    });
    expect(bad.status).toBe(400);
    expect(server.alive()).toBe(true);

    const good = await toolsList(port, "probe");
    expect(good.status).toBe(200);
  }, 30000);
});

describe("archstone serve --http — missing bearer token (Rule #7 / R-5)", () => {
  it("exits non-zero and never binds a port when neither --token nor ARCHSTONE_HTTP_TOKEN is set", async () => {
    const { ARCHSTONE_HTTP_TOKEN: _drop, ...envWithoutToken } = process.env;
    const proc = spawn(tsx, [cli, "serve", "--http", tourism, "--port", String(PORT + 2)], {
      cwd: root,
      env: envWithoutToken,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    const code = await new Promise<number | null>((res) => proc.on("exit", res));
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/bearer token required/);
  }, 20000);
});
