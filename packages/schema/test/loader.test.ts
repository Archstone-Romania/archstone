import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

/** Create a throwaway manifest dir from a map of relative path -> contents. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    // rel here is always flat (no subdirs) in these tests
    writeFileSync(full, content);
  }
  return dir;
}

describe("load — valid fixtures", () => {
  it("loads the booking manifest clean", () => {
    const r = load(join(manifests, "booking"));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.capabilities?.company.id).toBe("booking");
    expect(r.capabilityDocs).toHaveLength(4);
    expect(r.capabilityDocs.map((d) => d.capability.id)).toContain("tourism.search");
    expect(r.bindings).toHaveLength(1);
  });

  it("loads the bank manifest clean", () => {
    const r = load(join(manifests, "bank"));
    expect(r.ok).toBe(true);
    expect(r.capabilityDocs).toHaveLength(4);
    // effect enum is honoured (bank has an irreversible transfer)
    expect(r.capabilityDocs.map((d) => d.capability.effect)).toContain("irreversible");
  });
});

describe("load — rejections (validation actually bites)", () => {
  it("reports a directory that does not exist", () => {
    const r = load("/tmp/archstone-does-not-exist-xyz");
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toMatch(/directory not found/);
  });

  it("flags missing required fields: providers (capabilities.yaml) and effect (capability)", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: bad\ncapabilities:\n  - tourism.search\n",
      "x.capability.yaml": "capability:\n  id: tourism.search\n  description: no effect field\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    const msgs = r.issues.map((i) => i.message).join(" | ");
    expect(msgs).toMatch(/providers/);
    expect(msgs).toMatch(/effect/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing capabilities.yaml", () => {
    const dir = fixture({
      "x.capability.yaml": "capability:\n  id: tourism.search\n  description: ok\n  effect: read\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "capabilities.yaml" && /missing/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles malformed YAML without throwing", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: ok\ncapabilities:\n  - tourism.search\nproviders:\n  - booking-api\n",
      "x.capability.yaml": "capability: [unterminated\n",
    });
    // must not throw — the bad file becomes an issue
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "x.capability.yaml" && /parse error/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
