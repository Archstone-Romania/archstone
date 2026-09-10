import { describe, it, expect } from "vitest";
import type { IRField, IRResourceRegistry, IRTool } from "@archstone/compiler";
import { applyResponseMapping } from "../src/mapping";

// Required-ness is the resource registry's, NOT the mapping's (single source of truth):
// name + price required, tag optional.
const resources: IRResourceRegistry = {
  "shop.Widget": [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
    { name: "tag", required: false, type: { kind: "scalar", semantic: "text" } },
  ],
};

function tool(response: IRTool["response"]): IRTool {
  return {
    id: "shop.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } }],
    response,
  };
}

const collectionMapping: IRTool["response"] = {
  resource: "shop.Widget",
  field: "items",
  collection: "$.results[*]",
  fields: [
    { name: "name", path: "$.n" },
    { name: "price", path: "$.p" },
    { name: "tag", path: "$.t" },
  ],
};

describe("applyResponseMapping (ADD-12)", () => {
  it("OK: maps each item to the resource, dropping unmapped provider fields", () => {
    const body = { results: [{ n: "Widget A", p: 9, t: "sale", junk: "dropped" }] };
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }] });
  });

  it("DEGRADED: an absent OPTIONAL field is omitted, result still returned", () => {
    const body = { results: [{ n: "Widget A", p: 9 }] }; // no tag
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["tag"]);
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9 }] });
  });

  it("VIOLATION: an absent REQUIRED field fails closed — no data returned", () => {
    const body = { results: [{ n: "Widget A" }] }; // no price
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["price"]);
    expect(r.data).toBeUndefined();
  });

  it("empty collection is OK (emptiness is not drift)", () => {
    const r = applyResponseMapping(tool(collectionMapping), { results: [] }, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [] });
  });

  it("requiredOverride:false loosens a required field to DEGRADED instead of VIOLATION", () => {
    const loosened: IRTool["response"] = {
      ...collectionMapping,
      fields: [
        { name: "name", path: "$.n" },
        { name: "price", path: "$.p", requiredOverride: false },
        { name: "tag", path: "$.t" },
      ],
    };
    const body = { results: [{ n: "Widget A", t: "sale" }] }; // no price, but loosened
    const r = applyResponseMapping(tool(loosened), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toContain("price");
  });

  it("no `collection`: maps a single object at the body root", () => {
    const single: IRTool["response"] = {
      resource: "shop.Widget",
      field: "items",
      fields: [
        { name: "name", path: "$.n" },
        { name: "price", path: "$.p" },
      ],
    };
    const r = applyResponseMapping(tool(single), { n: "Solo", p: 5 }, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: { name: "Solo", price: 5 } });
  });
});

// `tool.extract` (extends ADD-12 with a sibling binding block, per the accepted architecture
// decision): additional SCALAR output fields read straight off the raw body ROOT — never
// `mapping.collection`-scoped items — with required-ness sourced from `tool.output` directly
// (there is no resource registry entry for a scalar field).
describe("applyResponseMapping — extract (extends ADD-12)", () => {
  function toolWith(opts: { output: IRField[]; response?: IRTool["response"]; extract?: IRTool["extract"] }): IRTool {
    return {
      id: "shop.search",
      description: "",
      effect: "read",
      provider: "",
      policies: [],
      lifecycle: "stable",
      input: [],
      output: opts.output,
      response: opts.response,
      extract: opts.extract,
    };
  }

  const countOutput: IRField[] = [{ name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } }];

  it("extract:-only (no response: at all): OK maps the scalar field off the body root", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, { total: 42 }, {});
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ count: 42 });
  });

  it("extract:-only: required-ness comes from `tool.output` directly — a missing REQUIRED field is a VIOLATION", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["count"]);
    expect(r.data).toBeUndefined();
  });

  it("extract:-only: an absent OPTIONAL field DEGRADES, per `tool.output`'s own required: false", () => {
    const optionalOutput: IRField[] = [{ name: "count", required: false, type: { kind: "scalar", semantic: "quantity" } }];
    const t = toolWith({ output: optionalOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["count"]);
    expect(r.data).toEqual({});
  });

  it("extract:'s own requiredOverride:false loosens a required output field to DEGRADED", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total", requiredOverride: false }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["count"]);
  });

  it("response: + extract: together populate a single merged structuredContent (one MappingResult)", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    const body = { results: [{ n: "Widget A", p: 9, t: "sale" }], total: 1 };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }], count: 1 });
  });

  it("a missing required field from EITHER side merges into ONE violation, not two separate errors", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    // `price` (response:'s Widget field) AND `count` (extract:'s output field) both absent.
    const body = { results: [{ n: "Widget A", t: "sale" }] };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("violation");
    expect([...(r.missing ?? [])].sort()).toEqual(["count", "price"]);
    expect(r.data).toBeUndefined();
  });

  it("extract: reads the body ROOT, never `mapping.collection`-scoped items", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    // `total` sits at the body root, a sibling of `results` — NOT inside any result item.
    const body = { results: [{ n: "Widget A", p: 9, t: "sale", total: 999 }], total: 1 };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }], count: 1 });
  });
});
