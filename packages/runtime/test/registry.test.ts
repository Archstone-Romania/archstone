import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry, HEALTH_SNAPSHOT_FILE } from "../src/registry";

// `Registry` itself (index-only) moved to @archstone/emitter-support (ADD-0008 #27) — its
// unit test moved with it (packages/emitter-support/test/registry.test.ts). This file keeps
// only the file-backed pipeline (`buildRegistry`), which stays in @archstone/runtime.

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

describe("buildRegistry (file-backed pipeline)", () => {
  it("builds a registry for a valid manifest", () => {
    const r = buildRegistry(join(manifests, "booking"));
    expect(r.ok).toBe(true);
    expect(r.registry?.size).toBe(4);
    // ADD-30 (#30): no tool-name collision on a real manifest — the new gate is a no-op
    // here (cdl.schema.json's dotted `capability.id` pattern cannot itself produce a
    // toolName() collision; see registry.ts's header comment / emitter-support's
    // registry.test.ts for the synthetic-IR cases that exercise the gate directly).
    expect(r.registry?.toolNameCollisions).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === "tool-name-collision")).toBe(false);
  });

  it("returns no registry when there is a semantic error", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-reg-"));
    writeFileSync(join(dir, "capabilities.yaml"), "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n");
    writeFileSync(join(dir, "shop.search.capability.yaml"), "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: ghost\n");
    const r = buildRegistry(dir);
    expect(r.ok).toBe(false);
    expect(r.registry).toBeUndefined();
    expect(r.diagnostics.some((d) => d.code === "unknown-provider")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ADD-24 (#24) D-8/D-9: buildRegistry optionally reads a conventional health-snapshot file
// (HEALTH_SNAPSHOT_FILE, next to the manifest dir) and feeds it into the Registry. Fail-open
// on absence/malformed content — never mistakes "no snapshot" for "known bad".
describe("buildRegistry — health-snapshot file (ADD-24)", () => {
  it("absent snapshot file: fails open — registry builds with lifecycle-only exposure", () => {
    const r = buildRegistry(join(manifests, "booking"));
    expect(r.ok).toBe(true);
    expect(r.registry!.getExposure("tourism.search")).toEqual({ listed: true, invocable: true });
  });

  it("a valid snapshot's health composes into the tool's exposure hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-health-"));
    cpSync(join(manifests, "tourism"), dir, { recursive: true });
    writeFileSync(
      join(dir, HEALTH_SNAPSHOT_FILE),
      JSON.stringify({ results: [{ capabilityId: "tourism.search", status: "red", detail: "drift" }] }),
    );
    const r = buildRegistry(dir);
    expect(r.ok).toBe(true);
    expect(r.registry!.getExposure("tourism.search").hint?.level).toBe("deprecation");
    rmSync(dir, { recursive: true, force: true });
  });

  it("malformed JSON in the snapshot file fails open (no health data, no crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-health-bad-"));
    cpSync(join(manifests, "tourism"), dir, { recursive: true });
    writeFileSync(join(dir, HEALTH_SNAPSHOT_FILE), "{ not valid json");
    const r = buildRegistry(dir);
    expect(r.ok).toBe(true);
    expect(r.registry!.getExposure("tourism.search")).toEqual({ listed: true, invocable: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("a snapshot missing the `results` array fails open", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-health-shape-"));
    cpSync(join(manifests, "tourism"), dir, { recursive: true });
    writeFileSync(join(dir, HEALTH_SNAPSHOT_FILE), JSON.stringify({ error: "manifest_invalid" }));
    const r = buildRegistry(dir);
    expect(r.ok).toBe(true);
    expect(r.registry!.getExposure("tourism.search")).toEqual({ listed: true, invocable: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
