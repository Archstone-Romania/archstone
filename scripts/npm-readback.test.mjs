#!/usr/bin/env node
// Tests for the post-publish registry readback (#123).
//
//   node --test scripts/npm-readback.test.mjs
//
// The clock and the sleep are injected, so the ten-minute production timeout is exercised here
// in microseconds and no test waits on anything. What is NOT testable in this repo is a real
// `pnpm publish` against registry.npmjs.org — so what these tests pin down is the decision
// logic that sits on top of it: how a probe result is classified, how long we wait, when we
// give up, and which of those outcomes is allowed to fail a release.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResponse,
  packumentUrl,
  parseArgs,
  waitForVersion,
  DEFAULT_REGISTRY,
} from "./npm-readback.mjs";

// --- URL --------------------------------------------------------------------------------

test("packumentUrl: encodes the scope separator the way npm does", () => {
  assert.equal(packumentUrl(DEFAULT_REGISTRY, "@archstone/init"), "https://registry.npmjs.org/@archstone%2finit");
});

test("packumentUrl: tolerates a trailing slash on the configured registry", () => {
  assert.equal(packumentUrl("https://registry.npmjs.org/", "@archstone/cli"), "https://registry.npmjs.org/@archstone%2fcli");
});

// --- classification ---------------------------------------------------------------------
// The three states are the whole point: only a registry that ANSWERS and lists the version is
// success, and only a registry that ANSWERS without it counts as evidence of absence.

test("classifyResponse: present when the packument lists the version", () => {
  const body = JSON.stringify({ versions: { "0.14.0": {}, "0.15.0": {} } });
  assert.equal(classifyResponse({ status: 200, body }, "0.15.0").state, "present");
});

test("classifyResponse (#123): absent — the exact v0.15.0 packument, which claimed to have published", () => {
  // Real shape from the incident: publish logged ✅, registry listed up to 0.14.0 only.
  const body = JSON.stringify({ "dist-tags": { latest: "0.14.0" }, versions: { "0.13.0": {}, "0.14.0": {} } });
  const r = classifyResponse({ status: 200, body }, "0.15.0");
  assert.equal(r.state, "absent");
  assert.match(r.detail, /newest 0\.14\.0/);
});

test("classifyResponse (backport): present even though `latest` points somewhere else entirely", () => {
  // A backport publishes with dist-tag `lts-X.Y` and must NEVER move `latest` (#93 / A-6 §6),
  // so on an LTS release the packument's `latest` is a HIGHER, unrelated version. Success here
  // is membership of `versions`, which is dist-tag-independent — the whole point. If anyone
  // ever "simplifies" this to compare against `dist-tags.latest`, every backport release fails
  // and only the frozen-version customers notice. This test is that tripwire.
  const body = JSON.stringify({
    "dist-tags": { latest: "0.15.0", "lts-0.11": "0.11.7" },
    versions: { "0.11.6": {}, "0.11.7": {}, "0.15.0": {} },
  });
  assert.equal(classifyResponse({ status: 200, body }, "0.11.7").state, "present");
});

test("classifyResponse: 404 is absent, not an error — a new package looks like this until it lands", () => {
  assert.equal(classifyResponse({ status: 404, body: "" }, "0.15.0").state, "absent");
});

test("classifyResponse: a 5xx is unknown, never absent", () => {
  // Reporting a registry outage as "your publish failed" would fail a good release.
  assert.equal(classifyResponse({ status: 503, body: "" }, "0.15.0").state, "unknown");
  assert.equal(classifyResponse({ status: 429, body: "" }, "0.15.0").state, "unknown");
});

test("classifyResponse: a thrown/aborted request is unknown", () => {
  const r = classifyResponse({ error: "ETIMEDOUT" }, "0.15.0");
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /ETIMEDOUT/);
});

test("classifyResponse: a 200 we cannot parse or understand is unknown, not absent", () => {
  assert.equal(classifyResponse({ status: 200, body: "<html>maintenance</html>" }, "0.15.0").state, "unknown");
  assert.equal(classifyResponse({ status: 200, body: JSON.stringify({ hello: "world" }) }, "0.15.0").state, "unknown");
});

// --- polling ----------------------------------------------------------------------------

/** A fake clock: `sleep` advances it, so backoff and deadlines are exercised without waiting. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    slept: [],
  };
}

function scriptedProbe(states) {
  let i = 0;
  const calls = [];
  const probe = async () => {
    const state = states[Math.min(i, states.length - 1)];
    i += 1;
    calls.push(state);
    return { state, detail: `scripted ${state}` };
  };
  probe.calls = calls;
  return probe;
}

test("waitForVersion: a publish that is already visible costs exactly one probe and no sleep", () => {
  const clock = fakeClock();
  return waitForVersion({ probe: scriptedProbe(["present"]), timeoutMs: 600_000, ...clock }).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
    assert.equal(r.elapsedMs, 0);
  });
});

test("waitForVersion: a SLOW publish succeeds — absent for a while, then present", async () => {
  // The other half of this issue's title. The v0.14.0 release took ~5 minutes to appear and was
  // entirely successful; a readback that failed it would be a worse bug than the one being fixed.
  const clock = fakeClock();
  const probe = scriptedProbe(["absent", "absent", "absent", "absent", "present"]);
  const r = await waitForVersion({ probe, timeoutMs: 600_000, ...clock });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 5);
  assert.ok(r.elapsedMs < 600_000, "must have finished well inside the timeout");
});

test("waitForVersion: a publish that never lands fails, after actually using the full window", async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(["absent"]);
  const r = await waitForVersion({ probe, timeoutMs: 600_000, ...clock });
  assert.equal(r.ok, false);
  assert.equal(r.state, "absent");
  assert.equal(r.elapsedMs, 600_000, "must wait the whole timeout before declaring failure");
  assert.ok(probe.calls.length > 5, `expected repeated probing, got ${probe.calls.length}`);
});

test("waitForVersion: backoff grows to the cap and never overshoots the deadline", async () => {
  const clock = fakeClock();
  const slept = [];
  const r = await waitForVersion({
    probe: scriptedProbe(["absent"]),
    timeoutMs: 600_000,
    initialDelayMs: 5_000,
    maxDelayMs: 30_000,
    now: clock.now,
    sleep: async (ms) => {
      slept.push(ms);
      await clock.sleep(ms);
    },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(slept.slice(0, 4), [5_000, 10_000, 20_000, 30_000], "exponential up to the cap");
  assert.ok(
    slept.every((ms) => ms <= 30_000),
    "no sleep may exceed the cap",
  );
  assert.equal(
    slept.reduce((a, b) => a + b, 0),
    600_000,
    "the sleeps must sum to exactly the timeout — never overshoot it",
  );
  assert.ok(slept.length < 30, `bounded number of requests, got ${slept.length}`);
});

test("waitForVersion: an unreachable registry is retried, then fails — it never reports success", async () => {
  // We cannot confirm, so we must not pass. But the failure must say "no answer", not "absent".
  const clock = fakeClock();
  const r = await waitForVersion({ probe: scriptedProbe(["unknown"]), timeoutMs: 600_000, ...clock });
  assert.equal(r.ok, false);
  assert.equal(r.state, "unknown");
});

test("waitForVersion: a blip in the middle of a slow publish does not end the wait", async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(["absent", "unknown", "unknown", "absent", "present"]);
  const r = await waitForVersion({ probe, timeoutMs: 600_000, ...clock });
  assert.equal(r.ok, true, "transient 5xx/network errors must not abort an otherwise fine wait");
  assert.equal(r.attempts, 5);
});

// --- single-probe (pre-publish idempotence) mode -----------------------------------------

test("waitForVersion: timeout 0 answers absence immediately — one probe, no waiting", async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(["absent"]);
  const r = await waitForVersion({ probe, timeoutMs: 0, unknownGraceMs: 20_000, ...clock });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1, "the idempotence check must not stall a release on 8 absent packages");
  assert.equal(r.elapsedMs, 0);
});

test("waitForVersion: timeout 0 still retries an UNANSWERED probe for the grace window", async () => {
  // Absence is an answer and needs no retry; "the registry did not respond" is not, and a
  // release should not be decided by one dropped packet.
  const clock = fakeClock();
  const probe = scriptedProbe(["unknown", "unknown", "present"]);
  const r = await waitForVersion({ probe, timeoutMs: 0, unknownGraceMs: 20_000, ...clock });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("waitForVersion: the unknown grace is bounded too", async () => {
  const clock = fakeClock();
  const r = await waitForVersion({ probe: scriptedProbe(["unknown"]), timeoutMs: 0, unknownGraceMs: 20_000, ...clock });
  assert.equal(r.ok, false);
  assert.equal(r.elapsedMs, 20_000);
});

test("waitForVersion: the unknown grace never shortens the main timeout", async () => {
  const clock = fakeClock();
  const r = await waitForVersion({ probe: scriptedProbe(["unknown"]), timeoutMs: 600_000, unknownGraceMs: 20_000, ...clock });
  assert.equal(r.elapsedMs, 600_000, "an unreachable registry must not cut the publish window short");
});

// --- argv --------------------------------------------------------------------------------

test("parseArgs: name, version and the seconds flags", () => {
  const a = parseArgs(["@archstone/init", "0.15.0", "--timeout-seconds", "600", "--unknown-grace-seconds", "20"]);
  assert.equal(a.name, "@archstone/init");
  assert.equal(a.version, "0.15.0");
  assert.equal(a.timeoutMs, 600_000);
  assert.equal(a.unknownGraceMs, 20_000);
});

test("parseArgs: rejects a missing version rather than polling for `undefined`", () => {
  assert.throws(() => parseArgs(["@archstone/init"]), /usage/);
});

test("parseArgs: rejects a non-numeric timeout rather than silently waiting NaN", () => {
  // `Number("") * 1000` is 0 and `Number("abc")` is NaN; either would quietly disable the wait.
  assert.throws(() => parseArgs(["a", "1.0.0", "--timeout-seconds", "abc"]), /must be a number/);
  assert.throws(() => parseArgs(["a", "1.0.0", "--timeout-seconds", "-5"]), /must be a number/);
});

test("parseArgs: rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["a", "1.0.0", "--wait-forever", "1"]), /unknown flag/);
});
