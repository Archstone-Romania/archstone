import { describe, it, expect } from "vitest";
import type { IRResourceRegistry, IRTool } from "@archstone/compiler";
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
