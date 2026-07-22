import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry } from "../src/registry";
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

// ADD-30 (#30): getCapability's sanitized-name index (byName), built minimally over
// synthetic IR tools rather than manifest fixtures, so each business rule is isolated.

function tool(overrides: Partial<IRTool> & Pick<IRTool, "id">): IRTool {
  return {
    description: `capability ${overrides.id}`,
    effect: "read",
    provider: "acme",
    policies: [],
    input: [],
    output: [],
    connector: { type: "rest", rest: { method: "GET", path: "/x" } },
    ...overrides,
  };
}

function ir(tools: IRTool[]): IR {
  return { version: "0", company: { id: "acme" }, tools, resources: {} };
}

describe("Registry.getCapability — sanitized-name index (ADD-30 D-1)", () => {
  it("BR-1: a sanitized, advertised name resolves back to its source capability", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" })]));
    expect(registry.getCapability("tourism_search")?.id).toBe("tourism.search");
  });

  it("BR-2: the raw dotted id still resolves", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" })]));
    expect(registry.getCapability("tourism.search")?.id).toBe("tourism.search");
  });

  it("BR-3: an id unaffected by sanitization has exactly one accepted (identical) form", () => {
    const registry = new Registry(ir([tool({ id: "billing_createInvoice" })]));
    expect(registry.getCapability("billing_createInvoice")?.id).toBe("billing_createInvoice");
    expect(registry.toolNameCollisions).toEqual([]);
  });

  it("BR-4/EC-2: an unresolved name (including empty string) returns undefined, never throws", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" })]));
    expect(registry.getCapability("does-not-exist")).toBeUndefined();
    expect(registry.getCapability("")).toBeUndefined();
  });

  it("BR-5/EC-3: an unbound capability's sanitized form does not resolve — same as unknown", () => {
    const registry = new Registry(ir([tool({ id: "tourism.book", connector: undefined })]));
    // raw id still resolves — BR-5 keeps this pre-existing behavior unaffected.
    expect(registry.getCapability("tourism.book")?.id).toBe("tourism.book");
    // its sanitized form was never advertised, so it's not a valid lookup target.
    expect(registry.getCapability("tourism_book")).toBeUndefined();
    expect(registry.invocableTools().map((n) => n.name)).not.toContain("tourism_book");
  });

  it("EC-6: no case-folding — a name differing only by case is unresolved", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" })]));
    expect(registry.getCapability("Tourism_Search")).toBeUndefined();
  });

  it("EC-7: getCapability never re-sanitizes its input — a raw string with unsanitized characters that matches nothing stays unresolved", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" })]));
    expect(registry.getCapability("tourism search")).toBeUndefined();
  });

  it("invocableTools() lists only bound capabilities, paired with their advertised name", () => {
    const registry = new Registry(
      ir([tool({ id: "tourism.search" }), tool({ id: "tourism.book", connector: undefined })]),
    );
    expect(registry.invocableTools()).toEqual([{ name: "tourism_search", tool: registry.getCapability("tourism.search") }]);
  });

  it("BR-6/EC-1: two distinct bound ids sanitizing to the same name are recorded as one collision, and neither the shared name nor the raw-id-shaped one resolves", () => {
    const registry = new Registry(ir([tool({ id: "a.b" }), tool({ id: "a_b" })]));
    expect(registry.toolNameCollisions).toEqual([{ name: "a_b", ids: expect.arrayContaining(["a.b", "a_b"]) }]);
    expect(registry.toolNameCollisions[0].ids).toHaveLength(2);
    // the shared sanitized name never resolves to an arbitrary winner...
    expect(registry.getCapability("a_b")).toBeUndefined();
    // ...but "a.b"'s own raw (dotted) id is a distinct string from the ambiguous "a_b" and
    // still resolves via byId — only the shared, contested string itself is blocked.
    expect(registry.getCapability("a.b")?.id).toBe("a.b");
    // neither capability is advertised as an invocable tool under the ambiguous name.
    expect(registry.invocableTools()).toEqual([]);
  });

  it("a collision naming three or more capabilities records every colliding id", () => {
    const registry = new Registry(ir([tool({ id: "a.b" }), tool({ id: "a_b" }), tool({ id: "a-b", connector: undefined })]));
    // "a-b" is unbound, so it never enters the byName construction — only the two bound
    // ids collide here.
    expect(registry.toolNameCollisions).toEqual([{ name: "a_b", ids: expect.arrayContaining(["a.b", "a_b"]) }]);
  });

  it("a registry with no collisions behaves byte-identical to today for byId lookups", () => {
    const registry = new Registry(ir([tool({ id: "tourism.search" }), tool({ id: "tourism.book" })]));
    expect(registry.toolNameCollisions).toEqual([]);
    expect(registry.getCapability("tourism.search")?.id).toBe("tourism.search");
    expect(registry.getCapability("tourism.book")?.id).toBe("tourism.book");
  });
});
