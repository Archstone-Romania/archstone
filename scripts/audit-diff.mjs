#!/usr/bin/env node
// New-advisory gate for audit.yml (dependency-audit hardening, in-repo, no issue number yet).
//
// The existing audit.yml gate ("Gate — production dependencies, high and above") answers
// "does a high-severity advisory exist anywhere in the shipped tree right now" — a question
// about the CURRENT state of main, not about what a given PR changed. That leaves two gaps a
// PR author can walk straight through:
//
//   1. `--prod` never looks at devDependencies, so a PR that bumps a dev tool (eslint,
//      vitest, wrangler) to a version with a fresh advisory sails through clean.
//   2. `--audit-level high` never looks at moderate, so a PR that adds/bumps a PRODUCTION
//      dependency to a version with a new MODERATE advisory (exactly what happened here with
//      qs/hono under @modelcontextprotocol/sdk) also sails through clean.
//
// This script is deliberately narrow instead of trying to replace that gate: it takes two
// `pnpm audit --json` snapshots (base branch, PR head) and fails only on an advisory that is
// NEW in head — present for head, absent for base. Pre-existing advisory debt on main (the 7
// moderate + 2 dev-high this repo already carries as of #58) is a separate, already-tracked
// concern and must not fail every unrelated PR just because it also touches a manifest.
//
//   node scripts/audit-diff.mjs <base-audit.json> <head-audit.json> [--severity=moderate]
//
// Exit 0 = no advisory in head's set is both NEW (absent from base) and at/above the severity
//          threshold. Exit 1 = at least one is. Exit 2 = usage/infra error (bad args, unparsable
//          JSON) — distinct from "found a new vulnerability", same fail-closed discipline as
//          release-gate.mjs's GateInfraError split.

import { readFileSync } from "node:fs";

// info < low < moderate < high < critical — npm/pnpm's own advisory severity ordering.
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function severityAtLeast(severity, threshold) {
  const s = SEVERITY_RANK[severity] ?? 0;
  const t = SEVERITY_RANK[threshold] ?? 0;
  return s >= t;
}

/**
 * Pure — normalizes one `pnpm audit --json` document into a flat list of advisory
 * occurrences, one per (advisory, affected version) pair actually found in the tree.
 *
 * `pnpm audit --json`'s top-level `advisories` object is keyed by an internal numeric id and
 * each entry carries one `findings[]` array of `{version, dev, ...}` — the same advisory can
 * show up against several resolved versions in a workspace (e.g. hoisted vs. nested). We key
 * each occurrence by GHSA id (falling back to the internal id when a GHSA id is absent) plus
 * module name plus the affected version, per the brief's "advisory ID / package+version pair"
 * — so a genuinely new *version* of an already-known advisory (rare, but possible if a
 * transitive dep gets pinned differently) still counts as new exposure.
 */
export function parseAdvisories(auditJson) {
  const advisories = auditJson?.advisories ?? {};
  const occurrences = new Map();
  for (const advisory of Object.values(advisories)) {
    const ghsa = advisory.github_advisory_id || `npm-advisory-${advisory.id}`;
    const versions = new Set((advisory.findings ?? []).map((f) => f.version));
    for (const version of versions) {
      const key = `${ghsa}::${advisory.module_name}::${version}`;
      occurrences.set(key, {
        key,
        ghsaId: advisory.github_advisory_id ?? null,
        module: advisory.module_name,
        version,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
      });
    }
  }
  return occurrences;
}

/**
 * Pure — advisory occurrences present in `headAdvisories` but absent from `baseAdvisories`,
 * keyed by the same (ghsaId/module/version) identity `parseAdvisories` produces. This is the
 * whole mechanism: no severity filtering happens here, so callers can report the full new set
 * and gate on a threshold independently (kept separate from `filterBySeverity` on purpose —
 * the report step wants everything new, the gate step wants only what crosses the line).
 */
export function diffAdvisories(baseAdvisories, headAdvisories) {
  const added = [];
  for (const [key, occurrence] of headAdvisories) {
    if (!baseAdvisories.has(key)) added.push(occurrence);
  }
  return added.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

/** Pure — the subset of a new-advisory list that should actually fail the gate. */
export function filterBySeverity(newAdvisories, threshold) {
  return newAdvisories.filter((a) => severityAtLeast(a.severity, threshold));
}

/** Pure — human-readable report, used for both the always-printed summary and the failure. */
export function formatReport(newAdvisories, { threshold }) {
  if (newAdvisories.length === 0) {
    return "No advisories introduced by this PR's dependency changes.";
  }
  const lines = [
    `${newAdvisories.length} advisor${newAdvisories.length === 1 ? "y" : "ies"} newly introduced by this PR` +
      ` (present in the PR's lockfile, absent from the base branch's):`,
    "",
  ];
  for (const a of newAdvisories) {
    const gate = severityAtLeast(a.severity, threshold) ? "FAILS gate" : `below --severity=${threshold} threshold`;
    lines.push(`  [${a.severity.toUpperCase()}] ${a.module}@${a.version} — ${a.title} (${gate})`);
    if (a.url) lines.push(`      ${a.url}`);
  }
  return lines.join("\n");
}

function readAuditJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`could not read audit JSON at ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `could not parse ${path} as JSON (pnpm audit may have printed a warning ahead of the JSON, or the ` +
        `run failed before producing output): ${err.message}`,
    );
  }
}

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = Object.fromEntries(
    argv
      .filter((a) => a.startsWith("--"))
      .map((a) => a.slice(2).split("="))
      .map(([k, v]) => [k, v ?? true]),
  );
  const [basePath, headPath] = positional;
  const severity = flags.severity ?? "moderate";
  if (!basePath || !headPath) {
    throw new Error("usage: node scripts/audit-diff.mjs <base-audit.json> <head-audit.json> [--severity=moderate]");
  }
  if (!(severity in SEVERITY_RANK)) {
    throw new Error(`--severity must be one of ${Object.keys(SEVERITY_RANK).join(", ")}, got "${severity}"`);
  }
  return { basePath, headPath, severity };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[audit-diff] ${err.message}`);
    process.exit(2);
  }

  let baseJson, headJson;
  try {
    baseJson = readAuditJson(args.basePath);
    headJson = readAuditJson(args.headPath);
  } catch (err) {
    console.error(`[audit-diff] ${err.message}`);
    process.exit(2);
  }

  const baseAdvisories = parseAdvisories(baseJson);
  const headAdvisories = parseAdvisories(headJson);
  const newAdvisories = diffAdvisories(baseAdvisories, headAdvisories);
  const failing = filterBySeverity(newAdvisories, args.severity);

  console.log(`[audit-diff] ${formatReport(newAdvisories, { threshold: args.severity })}`);

  if (failing.length > 0) {
    console.error(
      `\n[audit-diff] FAIL: this PR's dependency changes introduce ${failing.length} new advisor${failing.length === 1 ? "y" : "ies"} ` +
        `at or above "${args.severity}" that the base branch does not carry. Remediate before merge — ` +
        `prefer bumping the dependency that pulls the vulnerable version, or pin it out, rather than ` +
        `adding a lockfile override without discussion.`,
    );
    process.exit(1);
  }

  console.log(`[audit-diff] PASS: no new advisory at or above "${args.severity}" introduced.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
