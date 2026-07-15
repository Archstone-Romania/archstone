import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { validateSemantics, type Diagnostic } from "../src/validate";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

const codes = (d: Diagnostic[]) => d.map((x) => x.code);
const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
const warnings = (d: Diagnostic[]) => d.filter((x) => x.severity === "warning");

describe("validateSemantics — real fixtures", () => {
  it("booking: no errors; warns on unbound capabilities + unused provider", () => {
    const d = validateSemantics(load(join(manifests, "booking")));
    expect(errors(d)).toHaveLength(0);
    // only tourism.search has a binding → book/cancel/invoice unbound
    expect(warnings(d).filter((w) => w.code === "capability-without-binding")).toHaveLength(3);
    // 'crm' is declared but unused
    expect(codes(warnings(d))).toContain("unused-provider");
  });

  it("bank: no errors", () => {
    const d = validateSemantics(load(join(manifests, "bank")));
    expect(errors(d)).toHaveLength(0);
  });
});

describe("validateSemantics — cross-file failures", () => {
  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "archstone-sem-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it("flags an unknown provider", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
      "shop.search.capability.yaml": "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: ghost\n",
    });
    const d = validateSemantics(load(dir));
    expect(codes(errors(d))).toContain("unknown-provider");
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a declared capability with no file, and a binding to a missing capability", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\n  - shop.checkout\nproviders:\n  - store\n",
      "shop.search.capability.yaml": "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n",
      "bindings/ghost.binding.yaml": "binding:\n  capabilityId: shop.ghost\n  connector:\n    type: rest\n    rest:\n      method: GET\n      path: /x\n",
    });
    const d = validateSemantics(load(dir));
    expect(codes(errors(d))).toContain("declared-without-file"); // shop.checkout declared, no file
    expect(codes(errors(d))).toContain("binding-without-capability"); // binding -> shop.ghost
    rmSync(dir, { recursive: true, force: true });
  });
});
