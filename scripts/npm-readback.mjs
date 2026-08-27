#!/usr/bin/env node
// Ask the npm registry, and keep asking, whether a version is actually there (#123).
//
// `pnpm publish` exiting 0 and printing "✅ Published" is not evidence that a version reached
// the registry. At v0.15.0 it was not: run 32863148469 logged a successful publish of
// `@archstone/init@0.15.0`, exited 0, went green — and the registry's packument still listed
// 0.14.0 as `latest` with no 0.15.0 in `versions` at all. `@archstone/cli@0.15.0` published
// one step later pinning `"@archstone/init": "0.15.0"`, so the CLI was on the registry and
// resolvable by nobody (`npm error code ETARGET`) until a dispatch resume republished the one
// missing package. Every signal available inside the pipeline said the release was fine.
//
// This script is the missing witness: it reads the registry directly and answers one question
// — "can a consumer resolve NAME@VERSION right now?" — with three possible states.
//
// WHY NOT `npm view`, which release.yml already calls for idempotence:
//   `npm view` is answered from npm's local `_cacache` whenever the cached packument is still
//   within its `max-age` (registry packuments ship `cache-control: max-age=300`). A poll built
//   on it can therefore return the SAME stale answer for five minutes regardless of what the
//   registry now holds — which is both halves of this issue's title at once: it cannot see a
//   slow publish finish, and it cannot see a failed one fail. Node's `fetch` has no persistent
//   HTTP cache, so every probe here is a real request. We ask for the abbreviated packument
//   (`application/vnd.npm.install-v1+json`) because that is the exact document `npm install`
//   consults to resolve a version — so a `present` answer here means what we actually care
//   about, not something adjacent to it.
//
//   What that removes is the CLIENT-side cache, which is the one we control and the one that
//   made `npm view` useless here. It does not remove the registry's CDN: the request-side
//   `cache-control: no-cache` below is a request, not a guarantee, and a Fastly edge may serve
//   a stale copy anyway. That is survivable by design rather than by luck — an edge copy can
//   only ever UNDER-report (a snapshot taken before the publish cannot contain a version
//   published after it), so a stale edge costs a retry and never a false confirmation, and the
//   poll re-asks a few dozen times across the timeout, outliving the 300s edge TTL several
//   times over.
//
// The three states matter, and collapsing them would be the bug:
//   present — the registry answered, and the version is in `versions`. The only success.
//   absent  — the registry answered, and the version is not there. A real, informative answer.
//   unknown — we never got an answer (network error, 5xx, 429, unparseable body). NOT absence.
//             A blip must never be reported as "the publish failed", and must never be allowed
//             to resolve the question either way; it can only cause another attempt.
//
// Usage:
//   node scripts/npm-readback.mjs <name> <version> [--timeout-seconds N]
//                                                  [--unknown-grace-seconds N]
//                                                  [--registry URL]
// Exit 0 = confirmed present. Exit 1 = NOT confirmed present (absent, or never answered).
// The caller decides what that means; see release.yml, which uses it for both directions.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Registry path for a (possibly scoped) package name — npm encodes only the slash. */
export function packumentUrl(registryUrl, name) {
  return `${registryUrl.replace(/\/+$/, "")}/${name.replace(/\//g, "%2f")}`;
}

/**
 * Pure — turn one HTTP outcome into one of the three states. Separated from the request so the
 * classification (the part with the judgement in it) is testable without a network or a stub
 * server. `error` is any thrown/aborted request.
 */
export function classifyResponse({ status, body, error }, version) {
  if (error) return { state: "unknown", detail: `request failed: ${error}` };
  if (status === 404) {
    // The package itself is unknown to the registry. For a brand-new package that is the
    // expected state right up until the publish lands, so it is `absent`, not an error.
    return { state: "absent", detail: "registry has no packument for this package (404)" };
  }
  if (status !== 200) return { state: "unknown", detail: `registry returned HTTP ${status}` };
  let doc;
  try {
    doc = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return { state: "unknown", detail: `unparseable packument: ${e.message}` };
  }
  const versions = doc?.versions;
  if (!versions || typeof versions !== "object") {
    // A 200 with no `versions` map is not a statement that the version is missing — it is a
    // document we do not understand. Treating it as `absent` would fail a good release.
    return { state: "unknown", detail: "packument has no `versions` object" };
  }
  if (Object.prototype.hasOwnProperty.call(versions, version)) {
    return { state: "present", detail: `registry lists ${version}` };
  }
  const known = Object.keys(versions);
  return {
    state: "absent",
    detail: `registry lists ${known.length} version(s), newest ${known[known.length - 1] ?? "(none)"} — not ${version}`,
  };
}

/** One real probe. Bounded per-request so a hung connection cannot eat the whole window. */
export async function probeRegistry({ registryUrl, name, version, fetchImpl = fetch, requestTimeoutMs = 15_000 }) {
  try {
    const res = await fetchImpl(packumentUrl(registryUrl, name), {
      headers: {
        // The document `npm install` resolves against. The no-cache pair ASKS the CDN not to
        // answer from a stale edge copy; it cannot compel it, which is why a stale answer is
        // handled by design (see the note at the top) rather than assumed away.
        accept: "application/vnd.npm.install-v1+json",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = res.status === 200 ? await res.text() : "";
    return classifyResponse({ status: res.status, body }, version);
  } catch (e) {
    return classifyResponse({ error: e?.message ?? String(e) }, version);
  }
}

/**
 * Poll `probe` until it says `present`, or until the relevant deadline passes.
 *
 * Two deadlines, because the two non-success states deserve different patience:
 *   - `timeoutMs`      how long we will wait for a version we can see is `absent` to appear.
 *   - `unknownGraceMs` how long we keep retrying when we cannot get an answer at all. Never
 *                      shorter than `timeoutMs` in effect — being unable to reach the registry
 *                      is not a reason to stop earlier than we would have waited anyway.
 *
 * Clock and sleep are injected so the retry/backoff/timeout behaviour is unit-testable in
 * milliseconds instead of minutes. Every knob is a parameter for the same reason.
 */
export async function waitForVersion({
  probe,
  timeoutMs = 0,
  unknownGraceMs = 0,
  initialDelayMs = 5_000,
  maxDelayMs = 30_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  const start = now();
  const answerDeadline = start + timeoutMs;
  const unknownDeadline = start + Math.max(timeoutMs, unknownGraceMs);
  let delay = initialDelayMs;
  let attempts = 0;
  let last = { state: "unknown", detail: "no probe ran" };

  for (;;) {
    attempts += 1;
    last = await probe();
    if (last.state === "present") {
      return { ok: true, attempts, elapsedMs: now() - start, ...last };
    }
    const deadline = last.state === "unknown" ? unknownDeadline : answerDeadline;
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { ok: false, attempts, elapsedMs: now() - start, ...last };
    }
    const waitMs = Math.min(delay, remaining);
    log(`  attempt ${attempts}: ${last.state} — ${last.detail}; retrying in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    // Exponential up to a cap: the overwhelming majority of publishes are visible within
    // seconds, so the first retries are cheap and fast; the cap keeps a ten-minute wait to a
    // couple of dozen requests instead of hammering the registry.
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

/** Pure — argv → options. Exported so the flag parsing is covered too. */
export function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      i += 1;
      if (key === "registry") {
        opts.registryUrl = value;
      } else if (key === "timeout-seconds" || key === "unknown-grace-seconds") {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`--${key} must be a number of seconds, got "${value}"`);
        opts[key === "timeout-seconds" ? "timeoutMs" : "unknownGraceMs"] = seconds * 1000;
      } else {
        throw new Error(`unknown flag --${key}`);
      }
    } else {
      positional.push(a);
    }
  }
  const [name, version] = positional;
  if (!name || !version) throw new Error("usage: npm-readback.mjs <name> <version> [--timeout-seconds N]");
  return { name, version, ...opts };
}

/** The registry the publish actually used, so an .npmrc override can never make us poll the
 *  wrong host and fail every release. Falls back to the public default. */
function detectRegistry() {
  // Bounded: this runs inside a release step, and a wedged `npm` must not hang it. Anything
  // that is not plainly an http(s) URL (empty, an error, "undefined") falls back.
  const res = spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8", timeout: 10_000 });
  const out = (res.stdout ?? "").trim();
  return /^https?:\/\/\S+$/.test(out) ? out : DEFAULT_REGISTRY;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const registryUrl = args.registryUrl ?? detectRegistry();
  const timeoutMs = args.timeoutMs ?? 0;
  const unknownGraceMs = args.unknownGraceMs ?? 0;
  const label = `${args.name}@${args.version}`;

  if (timeoutMs > 0) console.log(`⏳ waiting for ${label} on ${registryUrl} (up to ${Math.round(timeoutMs / 1000)}s)`);

  const result = await waitForVersion({
    probe: () => probeRegistry({ registryUrl, name: args.name, version: args.version }),
    timeoutMs,
    unknownGraceMs,
    log: (line) => console.log(line),
  });

  const took = `${Math.round(result.elapsedMs / 1000)}s, ${result.attempts} probe(s)`;
  if (result.ok) {
    console.log(`✓ ${label} confirmed on ${registryUrl} (${took})`);
    return 0;
  }
  console.log(`✗ ${label} NOT confirmed on ${registryUrl} after ${took} — last state: ${result.state} (${result.detail})`);
  return 1;
}

// `import.meta.main` is Node >= 24; this repo's CI pins Node 22. Compare resolved file URLs
// (not string-concatenated paths, which differ for any path needing escaping).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
