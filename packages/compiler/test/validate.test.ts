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

  it("bank: no errors (all refs resolve to banking.* resources via P-7)", () => {
    const d = validateSemantics(load(join(manifests, "bank")));
    expect(errors(d)).toHaveLength(0);
  });

  it("tourism demo: no errors — collection Stay resolves to tourism.Stay", () => {
    const d = validateSemantics(load(join(manifests, "tourism")));
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

  it("flags an unresolved resource reference (unknown-resource)", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
      "shop.search.capability.yaml":
        "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n  output:\n    items:\n      collection: Widget\n",
    });
    const d = validateSemantics(load(dir));
    const e = errors(d).find((x) => x.code === "unknown-resource");
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/Widget/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a bare same-domain reference and transitively checks resource fields", () => {
    // Order.line references Widget (bare, same-domain → shop.Widget). Widget exists → clean.
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.get\nproviders:\n  - store\n",
      "shop.get.capability.yaml":
        "capability:\n  id: shop.get\n  description: get\n  effect: read\n  provider: store\n  output:\n    order:\n      ref: Order\n",
      "shop.Order.resource.yaml":
        "resource:\n  name: shop.Order\n  fields:\n    line:\n      ref: Widget\n",
      "shop.Widget.resource.yaml":
        "resource:\n  name: shop.Widget\n  fields:\n    sku:\n      type: identifier\n",
    });
    const d = validateSemantics(load(dir));
    expect(errors(d)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors when a resource's own field references an undefined resource (transitive)", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.get\nproviders:\n  - store\n",
      "shop.get.capability.yaml":
        "capability:\n  id: shop.get\n  description: get\n  effect: read\n  provider: store\n  output:\n    order:\n      ref: Order\n",
      "shop.Order.resource.yaml":
        "resource:\n  name: shop.Order\n  fields:\n    line:\n      ref: Ghost\n",
    });
    const d = validateSemantics(load(dir));
    const e = errors(d).find((x) => x.code === "unknown-resource");
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/Ghost/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags an ambiguous bare reference (same-domain qualified AND bare-named both exist)", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
      "shop.search.capability.yaml":
        "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n  output:\n    items:\n      collection: Widget\n",
      "shop.Widget.resource.yaml": "resource:\n  name: shop.Widget\n  fields:\n    sku:\n      type: identifier\n",
      "Widget.resource.yaml": "resource:\n  name: Widget\n  fields:\n    sku:\n      type: identifier\n",
    });
    const d = validateSemantics(load(dir));
    const e = errors(d).find((x) => x.code === "unknown-resource");
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/ambiguous/);
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

describe("validateSemantics — response mapping (ADD-12)", () => {
  // A shop.search manifest whose output is `items: collection Widget`, with a Widget
  // resource; each case swaps only the binding's `response:` block to isolate one diagnostic.
  function withResponse(responseBlock: string, opts?: { output?: string; widgetFields?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), "archstone-resp-"));
    const output = opts?.output ?? "  output:\n    items:\n      collection: Widget\n";
    const widgetFields = opts?.widgetFields ?? "    name:\n      type: text\n    price:\n      type: money\n";
    const files: Record<string, string> = {
      "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
      "shop.search.capability.yaml": `capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n${output}`,
      "shop.Widget.resource.yaml": `resource:\n  name: shop.Widget\n  fields:\n${widgetFields}`,
      "bindings/shop.search.binding.yaml":
        `binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      method: GET\n      path: /x\n${responseBlock}`,
    };
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it("clean mapping to a resolvable resource + field is silent", () => {
    const dir = withResponse("  response:\n    collection: \"$.results[*]\"\n    resource: Widget\n    map:\n      name: \"$.n\"\n      price: \"$.p\"\n");
    expect(errors(validateSemantics(load(dir)))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a mapping to an undefined resource (unknown-response-resource)", () => {
    const dir = withResponse("  response:\n    resource: Ghost\n    map:\n      name: \"$.n\"\n");
    expect(codes(errors(validateSemantics(load(dir))))).toContain("unknown-response-resource");
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a map key that is not a field of the resource (unknown-response-field)", () => {
    const dir = withResponse("  response:\n    resource: Widget\n    map:\n      bogus: \"$.n\"\n");
    const e = errors(validateSemantics(load(dir))).find((x) => x.code === "unknown-response-field");
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/bogus/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags an invalid JSONPath (bad-response-path)", () => {
    const dir = withResponse("  response:\n    resource: Widget\n    map:\n      name: \"$.[\"\n");
    expect(codes(errors(validateSemantics(load(dir))))).toContain("bad-response-path");
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags when no output field references the mapped resource (response-output-mismatch)", () => {
    // output is a scalar, so nothing references Widget → the mapped result has no home.
    const dir = withResponse("  response:\n    resource: Widget\n    map:\n      name: \"$.n\"\n", {
      output: "  output:\n    count:\n      type: quantity\n",
    });
    expect(codes(errors(validateSemantics(load(dir))))).toContain("response-output-mismatch");
    rmSync(dir, { recursive: true, force: true });
  });
});
