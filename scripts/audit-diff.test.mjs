#!/usr/bin/env node
// Regression tests for the pure helpers in audit-diff.mjs (the diff-based "did THIS PR
// introduce a new advisory" gate in audit.yml). Same rationale as release-gate.test.mjs:
// repo-root CI tooling lives outside the Vitest workspace, so this uses Node's built-in
// test runner instead of pulling in a framework dependency for one script.
//
//   node --test scripts/audit-diff.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdvisories, diffAdvisories, filterBySeverity, severityAtLeast, formatReport } from "./audit-diff.mjs";

function fakeAudit(advisories) {
  // Mirrors the real `pnpm audit --json` shape closely enough for these pure functions:
  // a numeric-id-keyed `advisories` object, each with `module_name`/`severity`/`findings`.
  const out = {};
  advisories.forEach((a, i) => {
    out[1000 + i] = {
      id: 1000 + i,
      module_name: a.module,
      severity: a.severity,
      title: a.title ?? `${a.module} vulnerability`,
      url: a.url ?? `https://github.com/advisories/${a.ghsaId}`,
      github_advisory_id: a.ghsaId,
      findings: (a.versions ?? [a.version]).map((version) => ({ version, dev: false })),
    };
  });
  return { advisories: out };
}

test("parseAdvisories: one finding version produces one occurrence keyed by ghsaId/module/version", () => {
  const json = fakeAudit([{ module: "qs", severity: "moderate", ghsaId: "GHSA-x5fp", version: "6.15.3" }]);
  const occurrences = parseAdvisories(json);
  assert.equal(occurrences.size, 1);
  assert.ok(occurrences.has("GHSA-x5fp::qs::6.15.3"));
});

test("parseAdvisories: multiple finding versions for one advisory produce multiple occurrences", () => {
  const json = fakeAudit([{ module: "hono", severity: "moderate", ghsaId: "GHSA-gqvv", versions: ["4.10.0", "4.11.0"] }]);
  const occurrences = parseAdvisories(json);
  assert.equal(occurrences.size, 2);
});

test("parseAdvisories: falls back to the internal numeric id when github_advisory_id is absent", () => {
  const json = fakeAudit([{ module: "left-pad", severity: "low", ghsaId: undefined, version: "1.0.0" }]);
  const occurrences = parseAdvisories(json);
  assert.equal(occurrences.size, 1);
  const [only] = occurrences.values();
  assert.equal(only.key, "npm-advisory-1000::left-pad::1.0.0");
});

test("parseAdvisories: empty advisories object (clean tree) yields no occurrences", () => {
  const occurrences = parseAdvisories({ advisories: {} });
  assert.equal(occurrences.size, 0);
});

test("diffAdvisories: an advisory present in both base and head is not reported as new", () => {
  const base = parseAdvisories(fakeAudit([{ module: "qs", severity: "moderate", ghsaId: "GHSA-x5fp", version: "6.15.3" }]));
  const head = parseAdvisories(fakeAudit([{ module: "qs", severity: "moderate", ghsaId: "GHSA-x5fp", version: "6.15.3" }]));
  assert.deepEqual(diffAdvisories(base, head), []);
});

test("diffAdvisories: pre-existing advisory debt on base never surfaces, even if head still carries it plus something new", () => {
  const base = parseAdvisories(
    fakeAudit([
      { module: "vitest", severity: "moderate", ghsaId: "GHSA-82fw", version: "3.0.5" },
      { module: "js-yaml", severity: "high", ghsaId: "GHSA-2883", version: "4.0.0" },
    ]),
  );
  const head = parseAdvisories(
    fakeAudit([
      { module: "vitest", severity: "moderate", ghsaId: "GHSA-82fw", version: "3.0.5" }, // unchanged debt
      { module: "js-yaml", severity: "high", ghsaId: "GHSA-2883", version: "4.0.0" }, // unchanged debt
      { module: "left-pad", severity: "critical", ghsaId: "GHSA-newone", version: "9.9.9" }, // genuinely new
    ]),
  );
  const added = diffAdvisories(base, head);
  assert.equal(added.length, 1);
  assert.equal(added[0].module, "left-pad");
});

test("diffAdvisories: a version bump onto a NEWLY vulnerable version counts as new, even for an already-known advisory id", () => {
  // Same GHSA id, but the version now resolved is different — this is exactly the "bumped to
  // a version that (newly) carries a known advisory" case from the brief.
  const base = parseAdvisories(fakeAudit([{ module: "qs", severity: "moderate", ghsaId: "GHSA-x5fp", version: "6.15.0" }]));
  const head = parseAdvisories(fakeAudit([{ module: "qs", severity: "moderate", ghsaId: "GHSA-x5fp", version: "6.15.3" }]));
  const added = diffAdvisories(base, head);
  assert.equal(added.length, 1);
  assert.equal(added[0].version, "6.15.3");
});

test("diffAdvisories: results are sorted highest severity first", () => {
  const base = parseAdvisories({ advisories: {} });
  const head = parseAdvisories(
    fakeAudit([
      { module: "a", severity: "moderate", ghsaId: "GHSA-a", version: "1.0.0" },
      { module: "b", severity: "critical", ghsaId: "GHSA-b", version: "1.0.0" },
      { module: "c", severity: "low", ghsaId: "GHSA-c", version: "1.0.0" },
    ]),
  );
  const added = diffAdvisories(base, head);
  assert.deepEqual(added.map((a) => a.module), ["b", "a", "c"]);
});

test("severityAtLeast: moderate threshold catches moderate and above, not low", () => {
  assert.equal(severityAtLeast("moderate", "moderate"), true);
  assert.equal(severityAtLeast("high", "moderate"), true);
  assert.equal(severityAtLeast("critical", "moderate"), true);
  assert.equal(severityAtLeast("low", "moderate"), false);
  assert.equal(severityAtLeast("info", "moderate"), false);
});

test("filterBySeverity: drops new advisories below the threshold", () => {
  const newAdvisories = [
    { module: "a", severity: "low", title: "t", url: "u" },
    { module: "b", severity: "moderate", title: "t", url: "u" },
    { module: "c", severity: "high", title: "t", url: "u" },
  ];
  const failing = filterBySeverity(newAdvisories, "moderate");
  assert.deepEqual(failing.map((a) => a.module), ["b", "c"]);
});

test("formatReport: clean diff reads as no-op, not silence", () => {
  const report = formatReport([], { threshold: "moderate" });
  assert.match(report, /No advisories introduced/);
});

test("formatReport: names the package, version, and advisory title for each new advisory", () => {
  const report = formatReport(
    [{ module: "left-pad", version: "9.9.9", severity: "critical", title: "Something bad", url: "https://example.invalid" }],
    { threshold: "moderate" },
  );
  assert.match(report, /left-pad@9\.9\.9/);
  assert.match(report, /Something bad/);
  assert.match(report, /FAILS gate/);
});
