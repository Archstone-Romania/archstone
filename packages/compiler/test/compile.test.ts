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
    resourceDocs: [],
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
    // `authenticated` removed from this demo capability as part of #32/ADD-32 (see
    // tourism/booking's tourism.search.capability.yaml comments) — this is a public
    // search, not a "whose data" capability, so only `rate-limited` remains.
    expect(search!.policies).toEqual(["rate-limited"]);

    const destination = search!.input.find((f) => f.name === "destination");
    expect(destination!.type).toEqual({ kind: "scalar", semantic: "location" });

    const preferences = search!.input.find((f) => f.name === "preferences");
    expect(preferences!.required).toBe(false);

    const accommodations = search!.output.find((f) => f.name === "accommodations");
    // Bare `Accommodation` canonicalizes to the same-domain qualified form (P-7).
    expect(accommodations!.type).toEqual({ kind: "collection", of: "tourism.Accommodation" });

    expect(search!.connector?.type).toBe("rest");
    expect(search!.connector?.rest?.path).toBe("/api/v1/hotels/search");
  });

  it("leaves unbound capabilities without a connector", () => {
    expect(ir.tools.find((t) => t.id === "tourism.book")!.connector).toBeUndefined();
  });

  it("marks a `ref:` field as identity, leaving a `type: Resource` field's identity absent (ADD-25)", () => {
    const book = ir.tools.find((t) => t.id === "tourism.book")!;
    // input.accommodation is `ref: Accommodation` — "by identity".
    const accommodation = book.input.find((f) => f.name === "accommodation")!;
    expect(accommodation.type).toEqual({ kind: "resource", name: "tourism.Accommodation", identity: true });
    // output.booking is `type: Booking` — "by representation": no `identity` key at all.
    const booking = book.output.find((f) => f.name === "booking")!;
    expect(booking.type).toEqual({ kind: "resource", name: "tourism.Booking" });
    expect(booking.type).not.toHaveProperty("identity");
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

  it("carries a rest connector's query param-name map through to IR (#26)", () => {
    const ir = compile(
      modelWith({
        type: "rest",
        rest: { baseUrl: "https://x.test", method: "GET", path: "/go", query: { widthCm: "width_cm" } },
      }),
    );
    expect(ir.tools[0].connector?.rest?.query).toEqual({ widthCm: "width_cm" });
  });

  it("leaves `query` undefined when the binding does not declare one (#26)", () => {
    const ir = compile(
      modelWith({ type: "rest", rest: { baseUrl: "https://x.test", method: "GET", path: "/go" } }),
    );
    expect(ir.tools[0].connector?.rest?.query).toBeUndefined();
  });
});

describe("compile — bank → IR", () => {
  it("carries the irreversible effect", () => {
    const ir = compile(load(join(manifests, "bank")));
    const transfer = ir.tools.find((t) => t.id === "banking.initiate-transfer");
    expect(transfer!.effect).toBe("irreversible");
  });
});

describe("compile — resource registry (#11)", () => {
  it("populates the registry with canonical keys and typed, described fields", () => {
    const ir = compile(load(join(manifests, "tourism")));
    // Registry keyed by canonical (qualified) name.
    expect(Object.keys(ir.resources)).toContain("tourism.Stay");
    const stay = ir.resources["tourism.Stay"];
    const location = stay.find((f) => f.name === "location");
    expect(location!.type).toEqual({ kind: "scalar", semantic: "location" });
    expect(location!.description).toMatch(/city|region|address/i);
    const rating = stay.find((f) => f.name === "rating");
    expect(rating!.required).toBe(false);

    // The tool output references the resource BY canonical name (not inlined).
    const search = ir.tools.find((t) => t.id === "tourism.search")!;
    expect(search.output.find((f) => f.name === "stays")!.type).toEqual({ kind: "collection", of: "tourism.Stay" });
  });

  it("canonicalizes nested resource refs and carries no JSON Schema in the IR", () => {
    const ir = compile(load(join(manifests, "booking")));
    // Booking.accommodation: `ref: Accommodation` (bare → canonical tourism.Accommodation),
    // "by identity" (ADD-25) — the resource is referenced, not inlined into the registry.
    const booking = ir.resources["tourism.Booking"];
    expect(booking.find((f) => f.name === "accommodation")!.type).toEqual({
      kind: "resource",
      name: "tourism.Accommodation",
      identity: true,
    });
    // No emit-target lowering leaked into the IR.
    expect(JSON.stringify(ir.resources)).not.toMatch(/properties|inputSchema|"type":\s*"object"/);
  });
});

describe("compile — response mapping (ADD-12)", () => {
  it("lowers the tourism binding's response: canonical resource, output field, parsed paths", () => {
    const ir = compile(load(join(manifests, "tourism")));
    const search = ir.tools.find((t) => t.id === "tourism.search")!;
    expect(search.response).toBeDefined();
    // Bare `Stay` canonicalizes to tourism.Stay (P-7); bound to the `stays` output field (D-7).
    expect(search.response!.resource).toBe("tourism.Stay");
    expect(search.response!.field).toBe("stays");
    expect(search.response!.collection).toBe("$.stays[*]");
    const price = search.response!.fields.find((f) => f.name === "pricePerNight");
    expect(price!.path).toBe("$.pricePerNight");
  });
});

describe("compile — contract snapshot (ADD-18)", () => {
  it("lowers the tourism binding's contract: fingerprint + fixture path", () => {
    const ir = compile(load(join(manifests, "tourism")));
    const search = ir.tools.find((t) => t.id === "tourism.search")!;
    expect(search.contract).toBeDefined();
    expect(search.contract!.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(search.contract!.probeFixture).toBe("fixtures/tourism.search.golden.json");
  });
});
