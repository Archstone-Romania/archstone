#!/usr/bin/env node
// Release gate (#33 / ADD-33) — build + verify every example manifest against the exact,
// packed/installable `@archstone/*` artifacts a release is about to publish. Never the
// monorepo's live `workspace:*`-linked source (that's what the existing "Build gate
// (lint+typecheck+test)" step already exercises, and it did not catch #25/#26).
//
// Mechanism (ADD-33 §0, OQ-1): ephemeral local Verdaccio registry, seeded from `pnpm pack`
// output for every `private:false` workspace package. The `@archstone` scope resolves ONLY
// from that local registry (it cannot resolve from the real npm registry — this version
// doesn't exist there yet); every other dependency (ajv, yaml, jsonpath-plus,
// @modelcontextprotocol/sdk, ...) still resolves from the real registry. A scratch consumer
// directory (no workspace file, no tsx/TypeScript) then does a real
// `npm install @archstone/cli@<version>` and runs the installed bin, exactly as a stranger
// following the README's quickstart would.
//
// Also runs a live MCP `serve` probe (#24 follow-up) against the same packed/installed
// binary: a synthetic manifest exercising all 5 lifecycle states, driven by a real
// `@modelcontextprotocol/sdk` client (resolved from the consumer's own real node_modules,
// same never-workspace-source discipline). Catches an MCP-listing/invocation regression
// (ADD-24: lifecycle hints/blocking, and binding-health hint composition + fail-open behavior)
// that `build`/`verify` alone can never see, since neither of those commands starts the MCP
// server or speaks the protocol.
//
// Run from the repo root, normally as a step in .github/workflows/release.yml, inserted
// after "Stamp version and sync private main" (so every package.json already carries the
// real tagged version) and before "Publish snapshot + tag to public" — GitHub Actions'
// default fail-fast stops both downstream publish steps on this step's non-zero exit.
//
//   node scripts/release-gate.mjs
//
// Also runs `archstone init` (ADD-37 §6 step 8) against the same packed/installed binary,
// non-interactively and WITHOUT --probe: `init` is the first verb whose graph reaches a newly
// published package (`@archstone/init`), and a workspace-green `init` proves nothing about the
// published one. It then re-checks the generated manifest with the installed `archstone apply`,
// because "the real compiler compiled this" is the claim `init` makes and the gate must not
// take init's own exit code for it.
//
// Exit 0 = every in-scope manifest's build/verify passed, and the init and lifecycle-serve probes passed.
// Exit 1 = at least one manifest or probe failed, OR the gate's own infrastructure failed
//          (packaging, registry, install) before any manifest could be evaluated.

import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Public-repo edition: the workspace IS the repo root — there is no archstone/ subdirectory.
const ARCHSTONE_DIR = ROOT;
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "release.yml");
const MANIFESTS_DIR = join(ARCHSTONE_DIR, "examples", "manifests");
const MOCK_SERVER = join(ARCHSTONE_DIR, "examples", "demo", "mock-stays-server.mjs");

// Pinned for determinism (BR-8: the build step must not be non-deterministic).
const VERDACCIO_VERSION = "6.8.0";

// Manifests whose contract-bearing binding(s) have no CI-safe backend today (ADD-33
// "Architectural challenge" + R-2 + §6 step 5): a real external design partner's production
// API, with no committed mock/sandbox and no CI secret. This is a NAMED, VISIBLE carve-out,
// not a silent skip — a manifest's verify leg is reported as "pending", never as a pass, and
// never fails the gate. Empty as of #35 (the one real external-partner manifest that needed
// this carve-out, `artvinci`, was retired from examples/manifests/ — its real contract now
// lives solely in that partner's own repository, per Issue #34's ownership pattern). Add an
// entry here again if/when a future real external-partner manifest lands with no CI-safe
// backend of its own.
const VERIFY_PENDING_NO_CI_BACKEND = new Set([]);

class GateInfraError extends Error {}

function log(msg) {
  console.log(`[release-gate] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------------------
// Step 1 (ADD-33 §6.1): discover every private:false workspace package, and assert this
// set is exactly what release.yml's "Stamp version" step lockstep-stamps (R-4 tripwire).
// ---------------------------------------------------------------------------------------

function discoverPublishablePackages() {
  const groups = ["packages", "providers"];
  const found = [];
  for (const group of groups) {
    const groupDir = join(ARCHSTONE_DIR, group);
    let entries;
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const absDir = join(groupDir, e.name);
      const pkgJsonPath = join(absDir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkg.private === false) {
        found.push({ relDir: `${group}/${e.name}`, absDir, name: pkg.name, version: pkg.version });
      }
    }
  }
  return found.sort((a, b) => a.relDir.localeCompare(b.relDir));
}

const STAMP_STEP_NAME = "Assert the tagged commit is stamped";
const PUBLISH_STEP_NAME = "Publish packages to npm";

/**
 * Every release.yml step that enumerates the publishable packages by hand.
 *
 * ADD-37 Amendment 1 O-19: the tripwire below used to guard the STAMP loop only, and the
 * publish loop — a second, independent hardcoded copy of the same list — was unguarded. A
 * package missing from each fails a release differently, and both failures are silent until
 * a user hits them:
 *
 *   - missing from STAMP   ⇒ it packs and publishes at a stale version;
 *   - missing from PUBLISH ⇒ it is never published at all, and every dependent package's
 *     `workspace:*` dep is rewritten at publish time to a concrete version that does not
 *     exist on the registry. `npm install @archstone/cli` then breaks for EVERYONE, and the
 *     first person to find out is a stranger following the README.
 *
 * The second is strictly worse and was the one nobody was checking. Guard both.
 */
const PACKAGE_LIST_STEPS = [STAMP_STEP_NAME, PUBLISH_STEP_NAME];

/** Pure — isolates a single named workflow step's text (from its `- name: <name>` line up
 *  to the next `- name:` line at the same indentation, or end of file). Returns null if the
 *  step isn't found. Scoping to the step is what makes `parsePackageLoop` immune to an
 *  unrelated `for p in ...; do` shell loop appearing earlier/elsewhere in the file (BF-1). */
export function isolateStep(workflowText, stepName) {
  const startRe = new RegExp(`^( *)- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const startMatch = startRe.exec(workflowText);
  if (!startMatch) return null;
  const indent = startMatch[1];
  const bodyStart = startMatch.index + startMatch[0].length;
  const nextStepRe = new RegExp(`^${indent}- name:`, "m");
  nextStepRe.lastIndex = 0;
  const rest = workflowText.slice(bodyStart);
  const nextMatch = nextStepRe.exec(rest);
  return nextMatch ? rest.slice(0, nextMatch.index) : rest;
}

/** Pure — parses the "for p in ...; do" loop out of ONE named step's `run:` block (BF-1:
 *  scoped to that named step, never the whole file — an unrelated same-shaped loop elsewhere
 *  in release.yml must never be mistaken for a real package list). */
export function parsePackageLoop(workflowText, stepName) {
  const stepText = isolateStep(workflowText, stepName);
  if (!stepText) return null;
  const m = stepText.match(/for p in ([^;]+); do/);
  if (!m) return null;
  return new Set(m[1].trim().split(/\s+/));
}

/** Pure — the stamp step's list. Kept as a named helper because it is the one the R-4
 *  tripwire was originally written against. */
export function parseStampList(workflowText) {
  return parsePackageLoop(workflowText, STAMP_STEP_NAME);
}

/** Pure — the publish step's list (ADD-37 Amendment 1 O-19). */
export function parsePublishList(workflowText) {
  return parsePackageLoop(workflowText, PUBLISH_STEP_NAME);
}

/** Pure — set diff between discovered private:false packages and one of the workflow's lists. */
export function diffStampList(discoveredRelDirs, stampedRelDirs) {
  const discovered = new Set(discoveredRelDirs);
  const missingFromStamp = [...discovered].filter((d) => !stampedRelDirs.has(d));
  const missingFromDiscovery = [...stampedRelDirs].filter((s) => !discovered.has(s));
  return { missingFromStamp, missingFromDiscovery };
}

/**
 * Pure — check the discovered package set against EVERY hardcoded list in release.yml.
 *
 * Returns `{ok: true}` or `{ok: false, message}`. Pure (no fs, no throw) so it is unit-testable
 * and so the same check can be asserted from inside the archstone/ Vitest suite, where it fails
 * in a PR rather than on a tag — which is the whole point (Amendment 1 §A-5 step 8 (iii)).
 */
export function checkWorkflowPackageLists(workflowText, discoveredRelDirs) {
  const problems = [];
  for (const stepName of PACKAGE_LIST_STEPS) {
    const list = parsePackageLoop(workflowText, stepName);
    if (!list) {
      problems.push(
        `  could not find the "${stepName}" step's package list (expected a "- name: ${stepName}" ` +
          `step containing a "for p in <paths>; do" loop) — release.yml's shape changed; update ` +
          `this parser before trusting the R-4 tripwire again.`,
      );
      continue;
    }
    const { missingFromStamp, missingFromDiscovery } = diffStampList(discoveredRelDirs, list);
    if (missingFromStamp.length > 0) {
      problems.push(`  private:false package(s) missing from "${stepName}": ${missingFromStamp.join(", ")}`);
    }
    if (missingFromDiscovery.length > 0) {
      problems.push(`  "${stepName}" names path(s) that are not private:false workspace packages: ${missingFromDiscovery.join(", ")}`);
    }
  }
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `package discovery mismatch (ADD-33 R-4 / ADD-37 Amendment 1 O-19) — every publishable package ` +
      `must appear in EVERY hardcoded list in release.yml, or a release silently ships an unstamped ` +
      `version or a dependency that was never published:\n${problems.join("\n")}`,
  };
}

/**
 * #101 — `server.json` (the MCP Registry manifest) carries the version twice and is NOT a
 * package, so it is invisible to the stamp loop above and to `discoverPublishablePackages`.
 * It therefore moves only when a human prepare commit remembers it, and at v0.11.7 nobody did:
 * the manifest still read 0.11.6 while the packages had moved on.
 *
 * That matters because the registry verifies ownership against the `mcpName` in the PUBLISHED
 * npm package and shows a consumer the version this file declares — so a drifted manifest either
 * advertises a version that is not current, or is refused at submission, and either failure
 * surfaces at the registry long after the release looked successful.
 *
 * Pure so the unit test can exercise it without a filesystem, and deliberately separate from the
 * package-list tripwire: that one is a set-comparison over `private:false` packages, and folding
 * a non-package path into it would break the very check it performs (ADD-33 R-4).
 */
export function checkServerManifestVersion(serverJson, rootVersion) {
  const mismatches = [];
  if (serverJson?.version !== rootVersion) {
    mismatches.push(`  server.json .version is "${serverJson?.version}", expected "${rootVersion}"`);
  }
  for (const [i, pkg] of (serverJson?.packages ?? []).entries()) {
    if (pkg?.version !== rootVersion) {
      mismatches.push(`  server.json .packages[${i}] (${pkg?.identifier ?? "?"}) is "${pkg?.version}", expected "${rootVersion}"`);
    }
  }
  if (mismatches.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `server.json version drift (#101) — the MCP Registry manifest is not a package, so the ` +
      `release workflow's stamp loop cannot reach it and it moves only when a prepare commit ` +
      `remembers. It did not at v0.11.7:\n${mismatches.join("\n")}`,
  };
}

function assertServerManifestVersion() {
  const serverJsonPath = join(ARCHSTONE_DIR, "server.json");
  if (!existsSync(serverJsonPath)) {
    log("no server.json — skipping registry-manifest version check.");
    return;
  }
  const rootVersion = JSON.parse(readFileSync(join(ARCHSTONE_DIR, "package.json"), "utf8")).version;
  const result = checkServerManifestVersion(JSON.parse(readFileSync(serverJsonPath, "utf8")), rootVersion);
  if (!result.ok) throw new GateInfraError(result.message);
  log(`server.json matches the root version (${rootVersion}).`);
}

function assertMatchesStampList(packages) {
  const workflowText = readFileSync(WORKFLOW_PATH, "utf8");
  const result = checkWorkflowPackageLists(workflowText, packages.map((p) => p.relDir));
  if (!result.ok) throw new GateInfraError(result.message);
  log(`package discovery matches every release.yml package list (${packages.length} packages).`);
}

// ---------------------------------------------------------------------------------------
// Step 1b (ADD-33 §6.1): pack each package. Tarball filenames follow npm's own convention
// for scoped packages (`@scope/name` -> `scope-name-version.tgz`), so we can assert
// existence deterministically without parsing `pnpm pack`'s build-tool-polluted stdout.
// ---------------------------------------------------------------------------------------

function packAll(packages, tarballDir) {
  for (const pkg of packages) {
    log(`packing ${pkg.name}@${pkg.version} (${pkg.relDir})...`);
    const res = spawnSync("pnpm", ["pack", "--pack-destination", tarballDir], {
      cwd: pkg.absDir,
      encoding: "utf8",
    });
    const tarballName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
    const tarballPath = join(tarballDir, tarballName);
    if (res.status !== 0 || !existsSync(tarballPath)) {
      // EC-4: a packaging failure fails closed, distinct from a manifest-level failure —
      // no build/verify probe is attempted at all.
      throw new GateInfraError(
        `packaging failure — 'pnpm pack' for ${pkg.name} exited ${res.status}, expected tarball not found ` +
          `at ${tarballPath}\n${res.stderr ?? res.stdout ?? ""}`,
      );
    }
    pkg.tarballPath = tarballPath;
  }
}

// ---------------------------------------------------------------------------------------
// Step 2 (ADD-33 §6.2): ephemeral local Verdaccio registry, disposable storage. `@archstone`
// has no uplink (it never proxies to the real npm registry); everything else does.
// ---------------------------------------------------------------------------------------

function findFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

async function startVerdaccio({ configDir, port }) {
  const storageDir = join(configDir, "storage");
  mkdirSync(storageDir, { recursive: true });
  const configPath = join(configDir, "config.yaml");
  writeFileSync(
    configPath,
    [
      `storage: ./storage`,
      `uplinks:`,
      `  npmjs:`,
      `    url: https://registry.npmjs.org/`,
      `packages:`,
      `  '@archstone/*':`,
      // No `proxy:` key here on purpose — this scope is local-only (ADD-33 §0/R-1): it can
      // never resolve from the real npm registry, which by construction doesn't have this
      // about-to-be-tagged version yet.
      `    access: $all`,
      `    publish: $all`,
      `    unpublish: $all`,
      `  '**':`,
      `    access: $all`,
      `    publish: $all`,
      `    proxy: npmjs`,
      `log: { type: stdout, format: pretty, level: warn }`,
      ``,
    ].join("\n"),
  );

  const child = spawn(
    "npx",
    ["--yes", `verdaccio@${VERDACCIO_VERSION}`, "--config", configPath, "--listen", `127.0.0.1:${port}`],
    { cwd: configDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout?.on("data", (c) => (out += c));
  child.stderr?.on("data", (c) => (out += c));

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new GateInfraError(`verdaccio exited early (code ${child.exitCode}):\n${out}`);
    }
    try {
      const r = await fetch(`${url}-/ping`);
      if (r.ok) {
        log(`ephemeral registry up at ${url}`);
        return { url, port, stop: () => child.kill() };
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  child.kill();
  throw new GateInfraError(`verdaccio did not become reachable at ${url} within 60s:\n${out}`);
}

function publishAll(packages, tarballDir, port) {
  const npmrcPath = join(tarballDir, ".npmrc");
  writeFileSync(
    npmrcPath,
    [`registry=http://127.0.0.1:${port}/`, `//127.0.0.1:${port}/:_authToken=local-release-gate-token`, ``].join(
      "\n",
    ),
  );
  for (const pkg of packages) {
    log(`publishing ${pkg.name}@${pkg.version} to the local registry...`);
    const res = spawnSync("npm", ["publish", pkg.tarballPath, "--userconfig", npmrcPath, "--loglevel=warn"], {
      cwd: tarballDir,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw new GateInfraError(
        `failed to publish ${pkg.name}@${pkg.version} to the local registry:\n${res.stderr ?? res.stdout ?? ""}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// Step 3 (ADD-33 §6.3): scratch consumer install — a real `npm install`, no workspace file,
// no tsx/TypeScript. Only `@archstone/*` is scoped to the local registry.
// ---------------------------------------------------------------------------------------

function installConsumer(consumerDir, cliPkg, port) {
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "archstone-release-gate-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  // Only @archstone is redirected — every other dependency (ajv, yaml, jsonpath-plus,
  // @modelcontextprotocol/sdk, ...) resolves from the real registry, exactly as a real
  // `npm install @archstone/cli` would for a stranger (BR-1).
  writeFileSync(join(consumerDir, ".npmrc"), `@archstone:registry=http://127.0.0.1:${port}/\n`);

  log(`npm install ${cliPkg.name}@${cliPkg.version} (real install, no workspace, no tsx/TS)...`);
  const res = spawnSync("npm", ["install", `${cliPkg.name}@${cliPkg.version}`, "--loglevel=warn"], {
    cwd: consumerDir,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new GateInfraError(
      `scratch 'npm install ${cliPkg.name}@${cliPkg.version}' failed:\n${res.stderr ?? res.stdout ?? ""}`,
    );
  }
}

/** Pure — R-1's mitigation: fail if any @archstone/* lockfile entry resolved anywhere other
 *  than the local registry (a false green one layer up from the workspace-source problem). */
export function findRegistryLeaks(packageLockJson, localRegistryPrefix) {
  const leaks = [];
  for (const [key, entry] of Object.entries(packageLockJson.packages ?? {})) {
    if (!key.includes("@archstone/")) continue;
    // NF-2 (fail-closed): a missing `resolved` field is itself an anomaly worth flagging,
    // not a reason to skip the entry — an @archstone/* lockfile entry with no resolvable
    // provenance is exactly the kind of thing this check exists to catch, not wave through.
    if (!entry?.resolved) {
      leaks.push(`${key} -> <no resolved field>`);
      continue;
    }
    if (!entry.resolved.startsWith(localRegistryPrefix)) leaks.push(`${key} -> ${entry.resolved}`);
  }
  return leaks;
}

function assertNoPublicRegistryLeak(consumerDir, port) {
  const lockPath = join(consumerDir, "package-lock.json");
  if (!existsSync(lockPath)) {
    throw new GateInfraError(
      `expected package-lock.json at ${lockPath} after install — cannot verify registry provenance`,
    );
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const leaks = findRegistryLeaks(lock, `http://127.0.0.1:${port}/`);
  if (leaks.length > 0) {
    throw new GateInfraError(
      `R-1: @archstone/* package(s) resolved from somewhere other than the local registry — the gate ` +
        `could silently validate a stale/public version instead of this tag's own packed artifact:\n` +
        leaks.map((l) => `  ${l}`).join("\n"),
    );
  }
  log(`confirmed: every @archstone/* dependency resolved from the local registry only.`);
}

function smokeTestBin(binPath) {
  if (!existsSync(binPath)) {
    throw new GateInfraError(`installed CLI bin not found at ${binPath}`);
  }
  // `archstone` with no args prints a usage line and exits 2 (packages/cli/src/index.ts) —
  // anything else (ENOENT, module-resolution failure, ...) means the scratch install itself
  // is broken, not any manifest.
  const res = spawnSync(binPath, [], { encoding: "utf8" });
  if (res.error || res.status !== 2) {
    throw new GateInfraError(
      `installed CLI bin '${binPath}' did not behave like a real archstone CLI (expected no-args usage/exit 2): ` +
        `status=${res.status} error=${res.error}\n${res.stderr ?? res.stdout ?? ""}`,
    );
  }
  log(`installed CLI bin runs under plain node (usage smoke test passed).`);
}

// ---------------------------------------------------------------------------------------
// Steps 4/5 (ADD-33 §6.4/§6.5): run build (always) and verify (unconditional call, ADD-18's
// own no-op-when-absent semantics fall out for free — BR-3) against every discovered manifest.
// ---------------------------------------------------------------------------------------

function discoverManifests() {
  return readdirSync(MANIFESTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function runBuildProbe({ name, binPath, outDir }) {
  const manifestDir = join(MANIFESTS_DIR, name);
  const outFile = join(outDir, `${name}.ir.json`);
  const res = spawnSync(binPath, ["build", manifestDir, "--out", outFile], {
    cwd: ARCHSTONE_DIR,
    encoding: "utf8",
  });
  return {
    manifest: name,
    command: "build",
    status: res.status === 0 ? "pass" : "fail",
    exitCode: res.status,
    detail: (res.status === 0 ? res.stdout : (res.stderr || res.stdout || "")).trim(),
  };
}

async function startMockBackend() {
  const port = await findFreePort();
  const child = spawn(process.execPath, [MOCK_SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (c) => (out += c));
  child.stderr?.on("data", (c) => (out += c));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new GateInfraError(`mock stays backend exited early:\n${out}`);
    try {
      const r = await fetch(url, { method: "POST", body: "{}" });
      if (r) {
        log(`mock stays backend up at ${url}`);
        return { url, close: () => child.kill() };
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  child.kill();
  throw new GateInfraError(`mock stays backend did not become reachable within 15s:\n${out}`);
}

// ---------------------------------------------------------------------------------------
// Lifecycle/health MCP-serve probe (#24 follow-up) — `build`/`verify` above never spawn
// `archstone serve` or speak MCP at all, so #24's lifecycle-listing/health-hint/invocation-
// blocking behavior (ADD-24) had no live check against the packed artifact. This probe
// writes its OWN synthetic manifest (one capability per lifecycle state, ADD-24's five) plus
// a companion driver script INTO the scratch consumer directory — so the driver's import of
// `@modelcontextprotocol/sdk` resolves via the consumer's own real `node_modules`
// (`@archstone/runtime`'s real dependency, transitively installed by the earlier `npm
// install @archstone/cli`), never the monorepo's workspace copy (same BR-1 discipline as the
// rest of this gate). The driver spawns the INSTALLED `archstone` bin directly via
// `StdioClientTransport`, connects a real MCP client, and asserts the exact behavior ADD-24
// specifies. Report shape matches build/verify probes so printReport needs no changes.
// ---------------------------------------------------------------------------------------

const LIFECYCLE_PROBE_STATES = ["stable", "beta", "deprecated", "experimental", "retired"];

function lifecycleProbeDriverSource() {
  return `
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN_PATH = process.argv[2];
const STATES = ${JSON.stringify(LIFECYCLE_PROBE_STATES)};

function fail(msg) {
  console.error("LIFECYCLE_PROBE_FAIL: " + msg);
  process.exit(1);
}
function ok(msg) {
  console.log("LIFECYCLE_PROBE_OK: " + msg);
}

function writeManifest(dir) {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    ["company:", "  id: release-gate-lifecycle-smoke", "capabilities:", ...STATES.map((l) => \`  - gate.\${l}\`), "providers:", "  - acme", ""].join("\\n"),
  );
  mkdirSync(join(dir, "bindings"));
  for (const l of STATES) {
    writeFileSync(
      join(dir, \`gate.\${l}.capability.yaml\`),
      ["capability:", \`  id: gate.\${l}\`, \`  description: A \${l} release-gate smoke capability.\`, "  effect: read", "  provider: acme", \`  lifecycle: \${l}\`, "  output:", "    value:", "      type: string", ""].join("\\n"),
    );
    writeFileSync(
      join(dir, "bindings", \`gate.\${l}.binding.yaml\`),
      ["binding:", \`  capabilityId: gate.\${l}\`, "  connector:", "    type: rest", "    rest:", '      baseUrl: "\${GATE_API_URL}"', "      method: GET", "      path: /x", ""].join("\\n"),
    );
  }
}

function startMock() {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify({ value: "ok" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      res({ url: \`http://127.0.0.1:\${port}\`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "archstone-gate-lifecycle-"));
writeManifest(dir);
const mock = await startMock();

const transport = new StdioClientTransport({
  command: BIN_PATH,
  args: ["serve", dir],
  cwd: dir,
  env: { ...getDefaultEnvironment(), GATE_API_URL: mock.url },
});
const client = new Client({ name: "release-gate-lifecycle-probe", version: "0" }, { capabilities: {} });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["gate_beta", "gate_deprecated", "gate_stable"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(\`tools/list expected exactly \${JSON.stringify(expected)}, got \${JSON.stringify(names)} — experimental/retired must be unlisted (ADD-24 D-10)\`);
  }
  ok("tools/list lists exactly stable/beta/deprecated; experimental/retired unlisted");

  const byName = new Map(tools.map((t) => [t.name, t.description]));
  const stableDesc = byName.get("gate_stable");
  if (!byName.get("gate_beta")?.includes("beta — interface may still change")) fail("beta tool's description missing its lifecycle hint text");
  if (!byName.get("gate_deprecated")?.includes("deprecated — avoid new usage")) fail("deprecated tool's description missing its lifecycle hint text");
  if (stableDesc !== "A stable release-gate smoke capability.") fail(\`stable tool's description unexpectedly changed/hinted: \${JSON.stringify(stableDesc)}\`);
  ok("beta/deprecated carry hint text; stable does not");

  const exp = await client.callTool({ name: "gate_experimental", arguments: {} });
  if (exp.isError) fail("gate_experimental (unlisted) should still be invocable by id, but callTool errored: " + JSON.stringify(exp.content));
  ok("experimental is unlisted but still invocable by id (ADD-24 D-10)");

  const retired = await client.callTool({ name: "gate_retired", arguments: {} });
  if (!retired.isError) fail("gate_retired should be BLOCKED (invocable:false) but callTool succeeded");
  if (retired.structuredContent !== undefined) fail("a blocked call must never carry structuredContent (ADD-19/ADD-24 SDK-crash precedent)");
  if (!retired._meta?.["dev.archstone/lifecycle_blocked"]) fail("a blocked call must carry the dev.archstone/lifecycle_blocked _meta key");
  ok("retired is unlisted AND blocks callTool via the namespaced _meta key, never structuredContent (ADD-24 D-11)");

  await client.close();

  // Health-snapshot half of ADD-24 (D-8/D-9): a fresh \`serve\` process re-reads
  // .archstone-health.json at startup, so each scenario below is its own connect/close pair
  // against the same manifest dir.
  const HEALTH_FILE = ".archstone-health.json";

  writeFileSync(join(dir, HEALTH_FILE), JSON.stringify({
    results: [{ capabilityId: "gate.stable", status: "red", detail: "probe failing" }],
  }));
  const t2 = new StdioClientTransport({ command: BIN_PATH, args: ["serve", dir], cwd: dir, env: { ...getDefaultEnvironment(), GATE_API_URL: mock.url } });
  const c2 = new Client({ name: "release-gate-lifecycle-probe-health", version: "0" }, { capabilities: {} });
  await c2.connect(t2);
  const { tools: tools2 } = await c2.listTools();
  const stableWithHealth = tools2.find((t) => t.name === "gate_stable")?.description;
  if (!stableWithHealth?.includes("binding health: red")) fail(\`red health snapshot did not compose a hint into gate_stable's description (ADD-24 D-8/D-9): \${JSON.stringify(stableWithHealth)}\`);
  const retiredCall2 = await c2.callTool({ name: "gate_retired", arguments: {} });
  if (!retiredCall2.isError) fail("gate_retired must still be blocked even with an unrelated health snapshot present");
  await c2.close();
  ok("red binding-health snapshot composes a caution/deprecation hint into tools/list (ADD-24 D-8/D-9)");

  writeFileSync(join(dir, HEALTH_FILE), "{ not valid json !!!");
  const t3 = new StdioClientTransport({ command: BIN_PATH, args: ["serve", dir], cwd: dir, env: { ...getDefaultEnvironment(), GATE_API_URL: mock.url } });
  const c3 = new Client({ name: "release-gate-lifecycle-probe-failopen", version: "0" }, { capabilities: {} });
  await c3.connect(t3);
  const { tools: tools3 } = await c3.listTools();
  if (tools3.map((t) => t.name).sort().join(",") !== "gate_beta,gate_deprecated,gate_stable") {
    fail(\`a malformed health snapshot must fail OPEN (lifecycle-only listing), not break serve: got \${JSON.stringify(tools3.map((t) => t.name))}\`);
  }
  await c3.close();
  ok("a malformed health-snapshot file fails open — serve keeps working on lifecycle-only exposure (ADD-24 D-9)");

  await mock.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  fail("unexpected exception: " + (err?.stack ?? err));
}
`;
}

async function runLifecycleServeProbe({ binPath, consumerDir }) {
  // Written INTO consumerDir (not the parent scratch dir) so the driver's bare-specifier
  // import of `@modelcontextprotocol/sdk` resolves via consumerDir/node_modules — the real,
  // transitively-installed copy from `npm install @archstone/cli`, never the workspace's.
  const driverPath = join(consumerDir, "lifecycle-probe.mjs");
  writeFileSync(driverPath, lifecycleProbeDriverSource());
  const res = spawnSync(process.execPath, [driverPath, binPath], { encoding: "utf8", cwd: consumerDir });
  const output = (res.stdout || "") + (res.stderr || "");
  const passed = res.status === 0 && !output.includes("LIFECYCLE_PROBE_FAIL");
  return {
    manifest: "lifecycle-smoke",
    command: "serve",
    status: passed ? "pass" : "fail",
    exitCode: res.status,
    detail: passed ? output.trim().split("\n").filter((l) => l.startsWith("LIFECYCLE_PROBE_OK")).join("\n") : output.trim(),
  };
}

/**
 * ADD-37 §6 step 8 — `archstone init` against the PACKED, installed CLI.
 *
 * The whole reason this belongs in the gate and not only in `pnpm test`: `init` is the first
 * verb whose package graph reaches a NEW published package (`@archstone/init`), and a
 * workspace-green `init` proves nothing about the published one. ADD-37 Amendment 1 O-19 is
 * exactly this failure — a `workspace:*` dep rewritten at publish time to a version that was
 * never published. The stamp/publish-list tripwire above catches the omission; this catches
 * everything else about the install, including a missing `exports` entry or an unbundled
 * dependency (`yaml`, which `init` newly needs at runtime).
 *
 * Non-interactive with a committed Decision Record, so there is no terminal and no prompt —
 * and, deliberately, NO `--probe`: the gate makes no live request on `init`'s behalf, which is
 * also a check that the default is off.
 */
function runInitProbe({ binPath, outDir }) {
  const specDir = join(ARCHSTONE_DIR, "packages", "init", "test", "fixtures", "openapi");
  const spec = join(specDir, "catalog.yaml");
  const workDir = join(outDir, "init-probe");
  mkdirSync(workDir, { recursive: true });

  const recordPath = join(workDir, "decisions.json");
  writeFileSync(
    recordPath,
    JSON.stringify({
      version: "0",
      company: { id: "acme", name: "Acme Parts" },
      provider: "acme-api",
      decisions: [
        { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
        { operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
      ],
    }),
  );

  const manifestDir = join(workDir, "manifest");
  const init = spawnSync(binPath, ["init", spec, "--out", manifestDir, "--decisions", recordPath, "--non-interactive"], {
    cwd: ARCHSTONE_DIR,
    encoding: "utf8",
  });
  const initOutput = ((init.stdout || "") + (init.stderr || "")).trim();
  if (init.status !== 0) {
    return { manifest: "init-probe", command: "init", status: "fail", exitCode: init.status, detail: initOutput };
  }

  const problems = [];
  if (!existsSync(join(manifestDir, "capabilities.yaml"))) problems.push("init reported success but wrote no capabilities.yaml");
  if (!existsSync(join(manifestDir, "INIT-REPORT.md"))) problems.push("no committable report was written (product §11.2)");
  if (existsSync(join(manifestDir, "fixtures"))) problems.push("a fixture was recorded without --probe — the opt-in leaked");

  // Challenge 2, re-checked against the PUBLISHED emitter rather than the workspace one. Each
  // of these compiles and then fails at serve/verify time, which is the worst place to find out.
  for (const entry of readdirSync(manifestDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const text = readFileSync(join(entry.parentPath ?? manifestDir, entry.name), "utf8");
    for (const [label, re] of [
      ["lifecycle:", /^\s*lifecycle:/m],
      ["policies:", /^\s*policies:/m],
      ["failures:", /^\s*failures:/m],
      ["contract:", /^\s*contract:/m],
      ["${caller.", /\$\{caller\./],
    ]) {
      if (re.test(text)) problems.push(`${entry.name} emits ${label}, which ADD-37 Challenge 2 forbids`);
    }
  }

  // THE CLAIM `init` MAKES IS "THE REAL COMPILER COMPILED THIS". Check it with the real
  // compiler, from the installed binary — not by trusting init's own exit code.
  const apply = spawnSync(binPath, ["apply", manifestDir], { cwd: ARCHSTONE_DIR, encoding: "utf8" });
  if (apply.status !== 0) problems.push(`the generated manifest does not pass \`archstone apply\`:\n${(apply.stdout || apply.stderr || "").trim()}`);

  return {
    manifest: "init-probe",
    command: "init",
    status: problems.length === 0 ? "pass" : "fail",
    exitCode: init.status,
    detail: problems.length === 0 ? `generated ${readdirSync(manifestDir).length} entries; \`archstone apply\` accepted them` : problems.join("\n"),
  };
}

async function runVerifyProbe({ name, binPath, mockUrl }) {
  if (VERIFY_PENDING_NO_CI_BACKEND.has(name)) {
    return {
      manifest: name,
      command: "verify",
      status: "pending",
      exitCode: null,
      detail:
        "pending: no CI-safe backend configured for this manifest's contract-bearing binding(s) " +
        "(no reachable CI sandbox/secret for its real external API yet — ADD-33 R-2). Reported, not " +
        "gated, and never silently skipped — per ADD-33 §6 step 5 (internal design record; cited by name, not linked).",
    };
  }
  const manifestDir = join(MANIFESTS_DIR, name);
  // STAYS_API_URL is harmless for manifests whose bindings don't use it (booking/bank point
  // at BOOKING_API_URL/CORE_BANKING_URL and declare no contract: block — `verify` no-ops
  // cleanly for them regardless, per ADD-18's own semantics, BR-3).
  const res = spawnSync(binPath, ["verify", manifestDir], {
    cwd: ARCHSTONE_DIR,
    encoding: "utf8",
    env: { ...process.env, STAYS_API_URL: mockUrl },
  });
  return {
    manifest: name,
    command: "verify",
    status: res.status === 0 ? "pass" : "fail",
    exitCode: res.status,
    detail: (res.stdout || res.stderr || "").trim(),
  };
}

// ---------------------------------------------------------------------------------------
// Step 6 (ADD-33 §6.6): consolidated report — every manifest x command, not just the first
// failure (EC-6/S-US4.4).
// ---------------------------------------------------------------------------------------

function printReport(results, packages) {
  const bar = "=".repeat(72);
  console.log(`\n${bar}`);
  console.log("Release gate report — examples/manifests/* against packed artifacts");
  console.log(bar);
  console.log(`\nPackages under test:`);
  for (const p of packages) console.log(`  ${p.name}@${p.version}`);
  console.log("");

  let failed = false;
  for (const r of results) {
    const icon = r.status === "pass" ? "✓" : r.status === "pending" ? "⧗" : "✗";
    const exitTxt = r.exitCode != null ? ` (exit ${r.exitCode})` : "";
    console.log(`${icon} ${r.manifest.padEnd(12)} ${r.command.padEnd(7)} ${r.status}${exitTxt}`);
    if (r.status !== "pass" && r.detail) {
      for (const line of r.detail.split("\n")) console.log(`    ${line}`);
    }
    if (r.status === "fail") failed = true;
  }

  console.log(`\n${bar}`);
  console.log(
    failed
      ? "✗ release gate FAILED — one or more manifests failed build or verify against the packed artifacts."
      : "✓ release gate passed for all in-scope manifests.",
  );
  console.log(`${bar}\n`);
  return failed;
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "archstone-release-gate-"));
  const tarballDir = join(scratch, "tarballs");
  const consumerDir = join(scratch, "consumer");
  const registryDir = join(scratch, "registry");
  const outDir = join(scratch, "out");
  for (const d of [tarballDir, consumerDir, registryDir, outDir]) mkdirSync(d, { recursive: true });

  let verdaccio;
  let mock;
  try {
    const packages = discoverPublishablePackages();
    assertMatchesStampList(packages);
  assertServerManifestVersion();

    packAll(packages, tarballDir);

    const port = await findFreePort();
    verdaccio = await startVerdaccio({ configDir: registryDir, port });
    publishAll(packages, tarballDir, port);

    const cliPkg = packages.find((p) => p.name === "@archstone/cli");
    if (!cliPkg) throw new GateInfraError("no @archstone/cli package discovered — cannot install a consumer");
    installConsumer(consumerDir, cliPkg, port);
    assertNoPublicRegistryLeak(consumerDir, port);

    const binPath = join(consumerDir, "node_modules", ".bin", "archstone");
    smokeTestBin(binPath);

    const manifests = discoverManifests();
    log(`discovered manifests: ${manifests.join(", ")}`);

    const results = [];
    for (const name of manifests) {
      results.push(runBuildProbe({ name, binPath, outDir }));
    }

    mock = await startMockBackend();
    for (const name of manifests) {
      results.push(await runVerifyProbe({ name, binPath, mockUrl: mock.url }));
    }

    results.push(runInitProbe({ binPath, outDir }));
    results.push(await runLifecycleServeProbe({ binPath, consumerDir }));

    const failed = printReport(results, packages);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    if (err instanceof GateInfraError) {
      // EC-11: distinct from a manifest-level failure — no manifest is misattributed here.
      console.error(`\n[release-gate] ✗ gate infrastructure failure (no manifest evaluated beyond this point):`);
      console.error(`  ${err.message}\n`);
    } else {
      console.error(`\n[release-gate] ✗ unexpected error:\n  ${err.stack ?? err}\n`);
    }
    process.exitCode = 1;
  } finally {
    try {
      mock?.close();
    } catch {
      // best effort
    }
    try {
      verdaccio?.stop();
    } catch {
      // best effort
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best effort — scratch dir is in the OS tmpdir, not load-bearing to clean up
    }
    // Force-exit: `verdaccio?.stop()`/`mock?.close()` send SIGTERM to the spawned child
    // processes, but neither is awaited, and `npx --yes verdaccio@...` in particular is known
    // to not always forward/honor that signal to the actual server process it execs. When
    // that happens, the child's stdio pipes stay open and Node's event loop never drains on
    // its own — the script had already logged its pass/fail report (this was confirmed live:
    // the v0.4.0 release run printed "release gate passed for all in-scope manifests" at
    // 20:06:51Z, then sat with no further output until manually cancelled 67+ minutes later).
    // Exiting explicitly with the already-computed code guarantees the process terminates
    // regardless of any straggler child-process handle, without changing pass/fail semantics.
    process.exit(process.exitCode ?? 0);
  }
}

// Only run when invoked directly (`node scripts/release-gate.mjs`) — importable for the
// pure helpers above (parseStampList/diffStampList/findRegistryLeaks) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
