import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

/**
 * A stay matching the shape recorded in the tourism binding's `contract:`.
 *
 * It carries the fields the demo backend returns but the manifest does NOT map — `boardType`,
 * `freeCancellationUntil`, `roomDescription`, and the commercial `net`/`commission` — because
 * the contract fingerprints the provider's WHOLE response, not the mapped subset. Drop one and
 * `verify` correctly reports a lost field (ADD-114), which is what these green-path tests would
 * otherwise trip over. Nothing here reaches a model: the mapping allowlist is what governs that
 * (ADR-0008), and `demo.integration.test.ts` is where that is asserted.
 */
/** The retired-gate fixture manifest keeps its own pre-ADD-114 contract, recorded against the
 *  five-field payload — so its probes must keep sending exactly that. Separate constant rather
 *  than a shared one: the two manifests pin different fingerprints on purpose, and collapsing
 *  them would couple an unrelated fixture to the demo manifest's next re-record. */
const RETIRED_GATE_STAY = {
  id: "azur-01",
  name: "Hotel Azur",
  location: "Nice, France",
  pricePerNight: 118,
  rating: 4.5,
};

const CLEAN_STAY = {
  id: "azur-01",
  name: "Hotel Azur",
  location: "Nice, France",
  pricePerNight: 118,
  rating: 4.5,
  boardType: "BREAKFAST",
  freeCancellationUntil: "2026-07-11",
  roomDescription: "Junior Suite, terrace",
  net: 92.04,
  commission: 14.16,
};

// `archstone verify` end to end: spawn the real CLI against the tourism demo manifest,
// pointed at a mock backend, and assert exit code + printed health status (ADD-18).

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");
const booking = resolve(root, "examples/manifests/booking");
const retiredGate = resolve(root, "packages/cli/test/fixtures/retired-gate");
const effectGate = resolve(root, "packages/cli/test/fixtures/effect-gate");

function startMock(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * Like `startMock`, but it REMEMBERS which paths were asked for.
 *
 * #124's claim is not "the report says it skipped"; it is "no request was issued". Those are
 * different claims, and only the second one is what a business owner cares about — a gate that
 * printed a skip line and then called anyway would satisfy an assertion on the report and fail
 * this one. Same posture as `init`'s probe tests (`init/test/probe.test.ts`), which count calls
 * to an injected fetch for exactly this reason.
 */
function startCountingMock(body: unknown): Promise<{ url: string; paths: () => string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      paths.push(req.url ?? "");
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({
        url: `http://localhost:${port}`,
        paths: () => [...paths],
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("archstone verify (ADD-18)", () => {
  it("exits 0 and prints green for a clean backend matching the golden fixture", async () => {
    const mock = await startMock({
      stays: [CLEAN_STAY],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(stdout).toMatch(/🟢 tourism\.search/);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("exits 1 and prints red when a required field is missing (drift)", async () => {
    const mock = await startMock({ stays: [{ name: "Hotel Azur", location: "Nice, France" }] }); // no pricePerNight
    try {
      await execFileAsync(tsx, [cli, "verify", tourism], { cwd: root, env: { ...process.env, STAYS_API_URL: mock.url } });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(1);
      expect(e.stdout).toMatch(/🔴 tourism\.search/);
    } finally {
      await mock.close();
    }
  }, 20000);
});

// #54 (ADD-51 D-6's named residual risk, R-2): the CI release gate must not go permanently red
// because a manifest retired a `contract:`-bearing capability without also deleting its
// contract block. `packages/cli/test/fixtures/retired-gate` carries `tourism.search` (stable,
// contract matches the mock) alongside `tourism.retired-search` (lifecycle: retired, contract
// deliberately mapped to a field the mock never returns — a guaranteed VIOLATION if ever
// probed).
describe("archstone verify — retired capability escapes the CI gate (#54)", () => {
  it("exits 0: the stable capability is green, the retired one with a broken contract never appears", async () => {
    const mock = await startMock({
      stays: [RETIRED_GATE_STAY],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", retiredGate, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      const doc = JSON.parse(stdout);
      expect(doc.results).toHaveLength(1);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "green" });
      expect(doc.results.find((r: { capabilityId: string }) => r.capabilityId === "tourism.retired-search")).toBeUndefined();
    } finally {
      await mock.close();
    }
  }, 20000);

  it("exits 0 on the human (non-json) path too, printing only the stable capability", async () => {
    const mock = await startMock({
      stays: [RETIRED_GATE_STAY],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", retiredGate], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(stdout).toMatch(/🟢 tourism\.search/);
      expect(stdout).not.toMatch(/tourism\.retired-search/);
    } finally {
      await mock.close();
    }
  }, 20000);
});

// #124 (ADD-124): `archstone verify` replayed a `write`/`irreversible` binding's golden fixture
// against the live backend with no regard for `effect` — so a `contract:` on `tourism.pay` made
// every CI run repeat a real charge. `archstone init --probe` has refused exactly this since
// ADD-37 (R-8); `verify` did not, and the asymmetry was the bug.
//
// `fixtures/effect-gate/` exists solely for these tests: the only contract-bearing binding in
// the shipped examples is `effect: read`, so without a synthetic manifest a fully green suite
// would say nothing at all about this change.
describe("archstone verify — the effect gate (#124)", () => {
  it("issues NO request for the write/irreversible bindings, while still verifying the read one", async () => {
    const mock = await startCountingMock({ stays: [RETIRED_GATE_STAY] });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", effectGate, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });

      // THE DoD ASSERTION: the backend was never asked to hold a room or take a payment.
      expect(mock.paths()).toEqual(["/v1/search"]);
      expect(mock.paths()).not.toContain("/v1/holds");
      expect(mock.paths()).not.toContain("/v1/payments");

      const doc = JSON.parse(stdout);
      // The read capability is verified exactly as before — this gate must not quietly turn
      // `verify` into a no-op.
      expect(doc.results).toHaveLength(1);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "green" });
      expect(doc.sandbox).toBe(false);

      // …and the skips are REPORTED, not silently omitted. A skipped binding must not be
      // mistakable for a passing one, so it never appears in `results` and carries no
      // green/yellow/red of its own (ADD-124 D-2).
      expect(doc.skipped).toHaveLength(2);
      const byId = Object.fromEntries(doc.skipped.map((s: { capabilityId: string }) => [s.capabilityId, s]));
      expect(byId["tourism.hold"]).toMatchObject({ effect: "write" });
      expect(byId["tourism.pay"]).toMatchObject({ effect: "irreversible" });
      for (const s of doc.skipped) {
        expect(s.detail).toBeTruthy();
        expect(s.status).toBeUndefined(); // no HealthStatus anywhere on a skip
      }
      expect(doc.results.map((r: { capabilityId: string }) => r.capabilityId)).not.toContain("tourism.pay");
    } finally {
      await mock.close();
    }
  }, 20000);

  it("exits 0 when everything contract-bearing was skipped — a correct refusal is not a failure (D-6)", async () => {
    // `--json` is deliberately absent AND the read capability is dropped from the picture by
    // pointing at a manifest where every skip is the whole story: here we simply assert the
    // exit code of the full run, which contains one green read and two skips.
    const mock = await startCountingMock({ stays: [RETIRED_GATE_STAY] });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", effectGate], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      // Visible in the human report, and visually distinct from 🟢/🟡/🔴 (issue DoD).
      expect(stdout).toMatch(/🟢 tourism\.search/);
      expect(stdout).toMatch(/⏭ tourism\.hold/);
      expect(stdout).toMatch(/⏭ tourism\.pay/);
      // Distinct from the three health icons — asserted one at a time rather than as a character
      // class, because each of 🟢🟡🔴 is a surrogate PAIR: `[🟢🟡🔴]` without the `u` flag is a
      // class of six half-characters and would quietly match things nobody intended.
      for (const icon of ["🟢", "🟡", "🔴"]) {
        expect(stdout).not.toContain(`${icon} tourism.pay`);
        expect(stdout).not.toContain(`${icon} tourism.hold`);
      }
      // The reason travels with the skip, so a reader is never left guessing why a binding
      // vanished from the report.
      expect(stdout).toMatch(/effect is `irreversible`/);
      // D-13: the read-twin alternative is named as a PATTERN, never as a guessed capability id
      // (nothing in CDL or the IR links a write capability to its read counterpart, D-11).
      expect(stdout).toMatch(/read` twin|`read` capability/);
      expect(stdout).toMatch(/--sandbox/);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("--sandbox re-includes them: the requests ARE issued, and the run says so", async () => {
    const mock = await startCountingMock({ stays: [RETIRED_GATE_STAY] });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", effectGate, "--json", "--sandbox"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(mock.paths().sort()).toEqual(["/v1/holds", "/v1/payments", "/v1/search"]);

      const doc = JSON.parse(stdout);
      expect(doc.results).toHaveLength(3);
      expect(doc.skipped).toEqual([]);
      // D-7: the run records HOW it was invoked, so a dashboard can tell "nothing dangerous was
      // replayed" from "everything was replayed because someone asserted a sandbox".
      expect(doc.sandbox).toBe(true);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("--sandbox is a flag, not a positional: it is not mistaken for the manifest directory", async () => {
    const mock = await startCountingMock({ stays: [RETIRED_GATE_STAY] });
    try {
      // Flag first, directory second — the same argv-order tolerance `--json` already has.
      const { stdout } = await execFileAsync(tsx, [cli, "verify", "--sandbox", effectGate, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(JSON.parse(stdout).sandbox).toBe(true);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("a red READ binding still fails the gate under --sandbox — the flag re-includes, it does not excuse", async () => {
    const mock = await startCountingMock({ stays: [{ name: "Hotel Azur", location: "Nice, France" }] }); // no pricePerNight
    try {
      await execFileAsync(tsx, [cli, "verify", effectGate, "--json", "--sandbox"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(1);
      expect(JSON.parse(e.stdout).results.find((r: { capabilityId: string }) => r.capabilityId === "tourism.search")).toMatchObject({
        status: "red",
      });
    } finally {
      await mock.close();
    }
  }, 20000);
});

describe("archstone verify --json (ADD-20)", () => {
  it("clean backend + --json → stdout parses as JSON, one entry, exit 0", async () => {
    const mock = await startMock({
      stays: [CLEAN_STAY],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      const doc = JSON.parse(stdout);
      expect(doc.results).toHaveLength(1);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "green" });
    } finally {
      await mock.close();
    }
  }, 20000);

  it("drifted/red backend + --json → exit 1, entry has status: red", async () => {
    const mock = await startMock({ stays: [{ name: "Hotel Azur", location: "Nice, France" }] }); // no pricePerNight
    try {
      await execFileAsync(tsx, [cli, "verify", tourism, "--json"], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(1);
      const doc = JSON.parse(e.stdout);
      expect(doc.results[0]).toMatchObject({ capabilityId: "tourism.search", status: "red" });
    } finally {
      await mock.close();
    }
  }, 20000);

  it("manifest with zero contract-bearing bindings + --json → empty results/skipped, exit 0", async () => {
    const { stdout } = await execFileAsync(tsx, [cli, "verify", booking, "--json"], { cwd: root });
    const doc = JSON.parse(stdout);
    // #124 (ADD-124 D-7) added `skipped` and `sandbox` as ADDITIVE success-envelope keys. The
    // exact-equality assertion is kept rather than loosened to `toMatchObject`, because it is
    // what pins ADD-20 D-2's disjointness: no `error`/`issues`/`errors` key leaks into the
    // success shape. `booking` declares no contracts at all, so BOTH lists are empty here —
    // "nothing to verify" and "declined to verify something" stay distinguishable.
    expect(doc).toEqual({ results: [], skipped: [], sandbox: false });
  }, 20000);

  it("invalid manifest + --json → exit 2, error: manifest_invalid, no results key", async () => {
    const badDir = resolve(root, "does-not-exist-manifest-dir");
    try {
      await execFileAsync(tsx, [cli, "verify", badDir, "--json"], { cwd: root });
      expect.fail("expected a non-zero exit code");
    } catch (err) {
      const e = err as { code: number; stdout: string };
      expect(e.code).toBe(2);
      const doc = JSON.parse(e.stdout);
      expect(doc.error).toBe("manifest_invalid");
      expect(doc.results).toBeUndefined();
    }
  }, 20000);

  it("stdout parses as a single JSON document with no interleaved free text (--json flag position independent)", async () => {
    const mock = await startMock({
      stays: [CLEAN_STAY],
    });
    try {
      // flag comes before the directory here, proving argv parsing tolerates either order
      const { stdout } = await execFileAsync(tsx, [cli, "verify", "--json", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(stdout.trim().split("\n")).toHaveLength(1);
    } finally {
      await mock.close();
    }
  }, 20000);

  it("default (non-json) invocation is unchanged", async () => {
    const mock = await startMock({
      stays: [CLEAN_STAY],
    });
    try {
      const { stdout } = await execFileAsync(tsx, [cli, "verify", tourism], {
        cwd: root,
        env: { ...process.env, STAYS_API_URL: mock.url },
      });
      expect(stdout).toMatch(/🟢 tourism\.search/);
      expect(() => JSON.parse(stdout)).toThrow();
    } finally {
      await mock.close();
    }
  }, 20000);
});
