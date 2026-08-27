#!/usr/bin/env node
// Executes release.yml's REAL publish-loop shell against stubbed binaries (#123).
//
//   node --test scripts/publish-loop.test.mjs
//
// A real `pnpm publish` to registry.npmjs.org cannot be exercised from a test, and the release
// gate's ephemeral local registry deliberately does not speak OIDC — so the publish step's
// control flow has never had a test at all. It is also the step that broke production twice:
// once as a five-minute window where `npm install @archstone/cli` failed (v0.14.0), once as a
// green run that published `@archstone/cli` on top of an `@archstone/init` the registry did not
// have (v0.15.0, #123).
//
// What is stubbed is only the network edge — `pnpm publish` and the registry readback. The
// loop itself, its ordering, its idempotence branch and its fail-fast are the real lines out of
// .github/workflows/release.yml, extracted from the file at test time. So this cannot drift
// from what CI actually runs: edit the step, and these tests run the edited step.
//
// The property under test, stated once: a package must never be published after a package it
// depends on failed to confirm. That is the v0.15.0 outage in one sentence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isolateStep } from "./release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_STEP_NAME = "Publish packages to npm";

/**
 * Pull the step's `run:` block out of the workflow as runnable shell.
 *
 * Deliberately not a YAML library: this repo's root has no package.json and no dependencies by
 * design (see release-gate.mjs, which parses the same file by hand for the same reason).
 */
function extractRunBlock(workflowText, stepName) {
  const stepText = isolateStep(workflowText, stepName);
  assert.ok(stepText, `step "${stepName}" not found in release.yml`);
  const lines = stepText.split("\n");
  const runIdx = lines.findIndex((l) => /^\s*run: \|\s*$/.test(l));
  assert.ok(runIdx >= 0, `step "${stepName}" has no "run: |" block`);
  const body = lines.slice(runIdx + 1);
  const first = body.find((l) => l.trim() !== "");
  const indent = first.match(/^\s*/)[0];
  const out = [];
  for (const line of body) {
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    if (!line.startsWith(indent)) break; // dedented out of the block
    out.push(line.slice(indent.length));
  }
  return out.join("\n");
}

const RUN_BLOCK = extractRunBlock(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"), PUBLISH_STEP_NAME);

/**
 * Run the extracted shell with stub `node`/`pnpm`/`npm` on PATH.
 *
 * The `node` stub intercepts ONLY the readback invocation and delegates everything else to the
 * real node — the loop's `node -p "require('./<pkg>/package.json').name"` must keep reading the
 * real workspace, or the test would stop being about the real package list.
 */
function runPublishStep({ scenario, env = {}, workspace = ROOT }) {
  const dir = join(tmpdir(), `archstone-publish-loop-${scenario}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const publishLog = join(dir, "published.txt");
  writeFileSync(publishLog, "");

  writeFileSync(
    join(bin, "node"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == *npm-readback.mjs ]]; then
  NAME="$2"; TIMEOUT="$5"
  case "${scenario}" in
    all-new)      [ "$TIMEOUT" = "0" ] && exit 1 || exit 0 ;;
    all-present)  exit 0 ;;
    fail-at-init) if [ "$TIMEOUT" = "0" ]; then exit 1; fi
                  if [ "$NAME" = "@archstone/init" ]; then exit 1; fi
                  exit 0 ;;
    *) echo "unknown scenario ${scenario}" >&2; exit 3 ;;
  esac
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash
echo "PUBLISHED:$(basename "$PWD")|$*" >> "$PUBLISH_LOG"
exit 0
`,
  );
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["node", "pnpm", "npm"]) chmodSync(join(bin, f), 0o755);

  const script = join(dir, "publish-step.sh");
  writeFileSync(script, RUN_BLOCK);

  const res = spawnSync("bash", ["-e", "-o", "pipefail", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      PUBLISH_LOG: publishLog,
      GITHUB_WORKSPACE: workspace,
      V: "0.15.0",
      DIST_TAG: "latest",
      READBACK_TIMEOUT_S: "600",
      READBACK_GRACE_S: "20",
      ...env,
    },
  });

  const rows = readFileSync(publishLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace("PUBLISHED:", "").split("|"));
  rmSync(dir, { recursive: true, force: true });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    published: rows.map((r) => r[0]),
    publishArgs: rows.map((r) => r[1] ?? ""),
  };
}

test("publish loop: a healthy release publishes every package, in dependency order, and exits 0", () => {
  const r = runPublishStep({ scenario: "all-new" });
  assert.equal(r.code, 0, `expected success, got ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.deepEqual(r.published, ["schema", "compiler", "emitter-support", "rest", "runtime", "agent", "init", "cli"]);
});

test("publish loop (#123): an unconfirmed package stops the release BEFORE its dependents publish", () => {
  // The v0.15.0 outage, reproduced: `@archstone/init` publishes but the registry never confirms
  // it. The old loop went on to publish `@archstone/cli`, which pins init exactly — putting a
  // package on the registry that nobody could install. It must now stop at init.
  const r = runPublishStep({ scenario: "fail-at-init" });
  assert.equal(r.code, 1, "an unconfirmed publish must fail the step");
  assert.ok(!r.published.includes("cli"), "@archstone/cli must NOT be published after init failed to confirm");
  assert.deepEqual(r.published, ["schema", "compiler", "emitter-support", "rest", "runtime", "agent", "init"]);
  assert.match(r.stdout, /::error::/, "must emit a GitHub error annotation, not just a non-zero exit");
  assert.match(r.stdout, /workflow_dispatch with version=0\.15\.0/, "must tell the operator how to resume");
});

test("publish loop: a backport publishes under its lts dist-tag and the readback still confirms it", () => {
  // A backport must never move `latest` (#93 / A-6 §6), so it ships with `--tag lts-X.Y`. The
  // readback confirms membership of the packument's `versions`, which is dist-tag-independent —
  // if it ever started asking about `latest` instead, mainline releases would keep passing and
  // only LTS customers would break. Asserted here as well as at the classifier, because this is
  // the level where the dist-tag is actually threaded through.
  const r = runPublishStep({ scenario: "all-new", env: { V: "0.11.7", DIST_TAG: "lts-0.11" } });
  assert.equal(r.code, 0, `a backport must publish cleanly, got ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.published.length, 8);
  for (const args of r.publishArgs) {
    assert.match(args, /--tag lts-0\.11/, "every backport publish must carry its lts dist-tag");
    assert.ok(!/--tag latest/.test(args), "a backport must never publish to latest");
  }
});

test("publish loop: a resumed run over an already-published version publishes nothing and exits 0", () => {
  // The documented recovery path. If this ever fails, the resume that fixed v0.15.0 stops working.
  const r = runPublishStep({ scenario: "all-present" });
  assert.equal(r.code, 0, `expected idempotent success, got ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.deepEqual(r.published, [], "nothing may be republished");
  assert.match(r.stdout, /already on npm — skipping \(idempotent\)/);
});

test("publish loop: a missing readback script fails BEFORE anything is published", () => {
  // Not a hypothetical worth skipping: the readback is invoked by path, and the failure mode of
  // discovering a rename after package 1 of 8 has shipped is the expensive one.
  const empty = join(tmpdir(), `archstone-no-readback-${process.pid}`);
  mkdirSync(empty, { recursive: true });
  const r = runPublishStep({ scenario: "all-new", workspace: empty });
  rmSync(empty, { recursive: true, force: true });
  assert.notEqual(r.code, 0, "must refuse to publish without the readback");
  assert.deepEqual(r.published, [], "nothing may be published before the preflight passes");
  assert.match(r.stdout, /::error::.*npm-readback\.mjs is missing/);
});

test("publish loop: an empty readback timeout refuses to run rather than silently not waiting", () => {
  // `--timeout-seconds ""` would be a 0s wait — the readback still "runs", still passes, and the
  // v0.15.0 blind spot is quietly back while the job stays green. Fail loudly instead.
  const r = runPublishStep({ scenario: "all-new", env: { READBACK_TIMEOUT_S: "" } });
  assert.notEqual(r.code, 0, "an unset/empty timeout must stop the step");
  assert.deepEqual(r.published, [], "nothing may be published with the readback disarmed");
});

test("the extracted run block really is the workflow's publish loop", () => {
  // Guards the extraction itself: if `extractRunBlock` silently returned the wrong text, every
  // test above would pass against nothing.
  assert.ok(RUN_BLOCK.includes("pnpm publish --access public"), "extracted block is not the publish step");
  assert.ok(/for p in .*packages\/cli; do/.test(RUN_BLOCK), "extracted block has no package loop");
  assert.ok(!RUN_BLOCK.startsWith(" "), "extracted block must be dedented to runnable shell");
});
