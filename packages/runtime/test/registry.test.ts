import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry, Registry } from "../src/registry";
import { compile } from "@archstone/compiler";
import { load } from "@archstone/schema";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

describe("Registry over IR", () => {
  const registry = new Registry(compile(load(join(manifests, "booking"))));

  it("lists and resolves capabilities", () => {
    expect(registry.size).toBe(4);
    expect(registry.listCapabilities().map((t) => t.id)).toContain("tourism.search");
    expect(registry.getCapability("tourism.search")?.effect).toBe("read");
    expect(registry.getCapability("does.not-exist")).toBeUndefined();
  });
});

describe("buildRegistry (file-backed pipeline)", () => {
  it("builds a registry for a valid manifest", () => {
    const r = buildRegistry(join(manifests, "booking"));
    expect(r.ok).toBe(true);
    expect(r.registry?.size).toBe(4);
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
