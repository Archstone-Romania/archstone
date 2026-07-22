import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry } from "../src/registry";

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
