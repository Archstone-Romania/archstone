import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, type LoadResult } from "@archstone/schema";
import { compile } from "../src/compile";

/** Minimal LoadResult carrying one capability + one binding, for connector-narrowing tests. */
function modelWith(connector: Record<string, unknown>): LoadResult {
  return {
    ok: true,
    dir: ".",
    capabilities: { company: { id: "acme", name: "Acme" }, capabilities: ["svc.do"], providers: [] },
    capabilityDocs: [{ file: "x.capability.yaml", capability: { id: "svc.do", description: "d", effect: "read" } }],
    bindings: [{ file: "svc.do.binding.yaml", binding: { capabilityId: "svc.do", connector } }],
    issues: [],
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

describe("compile — booking → IR", () => {
  const ir = compile(load(join(manifests, "booking")));

  it("produces one tool per capability, company carried", () => {
    expect(ir.version).toBe("0");
    expect(ir.company.id).toBe("booking");
    expect(ir.tools).toHaveLength(4);
  });

  it("lowers tourism.search: semantic input, collection output, policies, connector", () => {
    const search = ir.tools.find((t) => t.id === "tourism.search");
    expect(search).toBeDefined();
    expect(search!.effect).toBe("read");
    expect(search!.provider).toBe("booking-api");
    expect(search!.policies).toEqual(["authenticated", "rate-limited"]);

    const destination = search!.input.find((f) => f.name === "destination");
    expect(destination!.type).toEqual({ kind: "scalar", semantic: "location" });

    const preferences = search!.input.find((f) => f.name === "preferences");
    expect(preferences!.required).toBe(false);

    const accommodations = search!.output.find((f) => f.name === "accommodations");
    expect(accommodations!.type).toEqual({ kind: "collection", of: "Accommodation" });

    expect(search!.connector?.type).toBe("rest");
    expect(search!.connector?.rest?.path).toBe("/api/v1/hotels/search");
  });

  it("leaves unbound capabilities without a connector", () => {
    expect(ir.tools.find((t) => t.id === "tourism.book")!.connector).toBeUndefined();
  });
});

describe("compile — connector narrowing by type discriminant (NF-4)", () => {
  it("maps a rest connector's fields into a typed IRConnector", () => {
    const ir = compile(
      modelWith({ type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/go", body: "b" } }),
    );
    expect(ir.tools[0].connector).toEqual({
      type: "rest",
      rest: { baseUrl: "https://x.test", method: "POST", path: "/go", body: "b" },
    });
  });

  it("carries a non-rest known protocol as { type } without fabricating a rest block", () => {
    const ir = compile(modelWith({ type: "graphql", endpoint: "https://x.test/graphql" }));
    expect(ir.tools[0].connector).toEqual({ type: "graphql" });
  });

  it("drops an unknown connector type (never reaches IR)", () => {
    const ir = compile(modelWith({ type: "carrier-pigeon" }));
    expect(ir.tools[0].connector).toBeUndefined();
  });
});

describe("compile — bank → IR", () => {
  it("carries the irreversible effect", () => {
    const ir = compile(load(join(manifests, "bank")));
    const transfer = ir.tools.find((t) => t.id === "banking.initiate-transfer");
    expect(transfer!.effect).toBe("irreversible");
  });
});
