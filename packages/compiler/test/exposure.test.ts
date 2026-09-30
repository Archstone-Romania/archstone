import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSONPath } from "jsonpath-plus";
import { load } from "@archstone/schema";
import { compile } from "../src/compile";
import { describeShape, fingerprintShape, type JsonType, type ShapeMap } from "../src/fingerprint";
import { exposureOf, exposureOfIR, shapePathSteps, type ToolExposure } from "../src/exposure";
import type { IRResourceRegistry, IRTool } from "../src/ir";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

/** The body the tourism demo backend returns (examples/demo/mock-stays-server.mjs): mapped
 *  fields, the Amadeus/Hotelbeds vocabulary the manifest leaves unmapped, and `totalMatches`. */
const TOURISM_BODY = {
  stays: [
    {
      id: "azur-01",
      name: "Hotel Azur",
      location: "Nice, France",
      pricePerNight: 118,
      rating: 4.5,
      boardType: "BREAKFAST",
      freeCancellationUntil: "2026-07-11",
      roomDescription: "Junior Suite, terrace",
      net: 92.04,
      commission: 14.16,
    },
  ],
  totalMatches: 1,
};

const SAMPLE: Record<JsonType, unknown> = { string: "s", number: 1, boolean: true, null: null, array: [], object: {} };

/** A body whose `describeShape` is exactly `shape` — so the runtime's own evaluator can be run
 *  against a recorded contract that ships without a response body. */
function bodyFromShape(shape: ShapeMap): unknown {
  const root = { v: structuredClone(SAMPLE[shape["$"] ?? "object"]) as unknown };
  for (const path of Object.keys(shape).sort()) {
    if (path === "$") continue;
    const steps = shapePathSteps(path);
    let parent: unknown = root.v;
    for (const [i, step] of steps.entries()) {
      const last = i === steps.length - 1;
      const slot = "elem" in step ? 0 : step.key;
      const container = parent as Record<string | number, unknown>;
      if (last) container[slot] ??= structuredClone(SAMPLE[shape[path]]);
      parent = container[slot];
    }
  }
  return root.v;
}

/** JSON pointer → describeShape spelling: an index under an array becomes `[]`. */
function pointerToShapePath(body: unknown, pointer: string): string {
  let out = "$";
  let node = body;
  for (const raw of pointer.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    out += Array.isArray(node) ? "[]" : `.${seg}`;
    node = (node as Record<string, unknown>)[seg];
  }
  return out;
}

const pointers = (json: unknown, path: string) =>
  JSONPath({ path, json: json as never, resultType: "pointer", wrap: true }) as unknown as string[];

/**
 * THE ORACLE (ADD-309 R-6). Evaluate every mapping path the way the runtime does — the
 * collection, then each field on each item; `extract` off the body root — with jsonpath-plus
 * itself, and name the shape paths it actually reads. Each one must come out of `exposureOf` as
 * not withheld. The normaliser is under test; the evaluator is not.
 */
function pathsTheRuntimeReads(tool: IRTool, resources: IRResourceRegistry, body: unknown): string[] {
  const read: string[] = [];
  const r = tool.response;
  if (r) {
    const items = r.collection
      ? (JSONPath({ path: r.collection, json: body as never, resultType: "all", wrap: true }) as unknown as { pointer: string; value: unknown }[])
      : [{ pointer: "", value: body }];
    const errorMap = new Map((r.onError?.map ?? []).map((fm) => [fm.name, fm.path]));
    const rel = [
      ...r.fields.map((fm) => fm.path),
      ...(r.onError ? (resources[r.onError.errorResource] ?? []).map((f) => errorMap.get(f.name) ?? `$.${f.name}`) : []),
    ];
    for (const item of items) {
      for (const p of rel) for (const ptr of pointers(item.value, p)) read.push(pointerToShapePath(body, item.pointer + ptr));
    }
  }
  for (const fm of tool.extract ?? []) for (const ptr of pointers(body, fm.path)) read.push(pointerToShapePath(body, ptr));
  return read;
}

function withheldPaths(e: ToolExposure): string[] {
  if (e.withholds === "unknown") throw new Error(`${e.capabilityId}: no recorded shape`);
  return e.withholds.map((w) => w.path);
}

const STAY_RESOURCE: IRResourceRegistry = {
  "t.Stay": [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
    { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
  ],
  "t.Failure": [{ name: "code", required: true, type: { kind: "scalar", semantic: "identifier" } }],
};

/** A tool over `STAY_RESOURCE`, bound, with the given response/extract/contract. */
function tool(over: Partial<IRTool>): IRTool {
  return {
    id: "t.search",
    description: "search",
    effect: "read",
    provider: "p",
    policies: [],
    lifecycle: "stable",
    input: [
      { name: "where", required: true, type: { kind: "scalar", semantic: "location" } },
      { name: "budget", required: false, type: { kind: "scalar", semantic: "money" } },
    ],
    output: [
      { name: "stays", required: true, type: { kind: "collection", of: "t.Stay" } },
      { name: "total", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ],
    connector: { type: "rest", rest: { method: "GET", path: "/s" } },
    ...over,
  };
}

const contractOf = (body: unknown) => ({ fingerprint: fingerprintShape(body), shape: describeShape(body), probeFixture: "fixtures/t.json" });

// ---------------------------------------------------------------------------------------------

describe("the path normaliser (ADD-309 R-6)", () => {
  it("splits describeShape's spelling into steps", () => {
    expect(shapePathSteps("$")).toEqual([]);
    expect(shapePathSteps("$.stays[].price.amount")).toEqual([{ key: "stays" }, { elem: true }, { key: "price" }, { key: "amount" }]);
    expect(shapePathSteps("$.grid[][]")).toEqual([{ key: "grid" }, { elem: true }, { elem: true }]);
  });

  it("the tourism contract.shape is what describeShape produces over the demo backend's body", () => {
    const ir = compile(load(join(manifests, "tourism")));
    const contract = ir.tools.find((t) => t.id === "tourism.search")!.contract!;
    // Both halves of the recorded observation agree with the body, so the report below is
    // computed against the backend's real shape, not a hand-typed one.
    expect(describeShape(TOURISM_BODY)).toEqual(contract.shape);
    expect(fingerprintShape(TOURISM_BODY)).toBe(contract.fingerprint);
  });

  it("every path the runtime reads for tourism.search, over describeShape of the demo body, is exposed", () => {
    const ir = compile(load(join(manifests, "tourism")));
    const t = ir.tools.find((x) => x.id === "tourism.search")!;
    const withheld = withheldPaths(exposureOf({ ...t, contract: contractOf(TOURISM_BODY) }, ir.resources));
    const read = pathsTheRuntimeReads(t, ir.resources, TOURISM_BODY);
    expect(read.sort()).toEqual(["$.stays[].location", "$.stays[].name", "$.stays[].pricePerNight", "$.stays[].rating", "$.totalMatches"]);
    for (const p of read) expect(withheld).not.toContain(p);
  });

  it("every response.map / extract in examples/manifests: a mapped field is never withheld", () => {
    let checked = 0;
    for (const dir of readdirSync(manifests, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const ir = compile(load(join(manifests, dir.name)));
      for (const t of ir.tools) {
        if (!t.response && !t.extract) continue;
        // A recorded shape when there is one; a body synthesised from the mapping's own targets
        // would be circular, so a tool without one is checked against its recorded contract only.
        if (!t.contract?.shape) continue;
        const body = bodyFromShape(t.contract.shape);
        expect(describeShape(body)).toEqual(t.contract.shape);
        const withheld = withheldPaths(exposureOf(t, ir.resources));
        const read = pathsTheRuntimeReads(t, ir.resources, body);
        expect(read.length).toBeGreaterThan(0);
        for (const p of read) expect(withheld, `${dir.name}/${t.id}: ${p}`).not.toContain(p);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // the walk found at least one mapped, contract-bearing binding
  });

  // Path spellings the examples do not use, each run through the same oracle.
  const body = {
    data: { items: [{ attrs: { name: "n", secret: 1 }, price: { amount: 3, cost: 2 }, "a.b": 1, other: 0 }] },
    meta: { count: 1, internal: "x" },
    code: "c",
  };
  const cases: { label: string; collection?: string; fields: [string, string][]; extract?: [string, string][]; withheld: string[] }[] = [
    {
      label: "nested collection + nested relative paths",
      collection: "$.data.items[*]",
      fields: [["name", "$.attrs.name"], ["price", "$.price.amount"]],
      withheld: ["$.code", "$.data.items[].a.b", "$.data.items[].attrs.secret", "$.data.items[].other", "$.data.items[].price.cost", "$.meta", "$.meta.count", "$.meta.internal"],
    },
    {
      label: "bracket notation and an index",
      collection: "$['data']['items'][0]",
      fields: [["name", "$.attrs['name']"], ["price", "$['price']"]],
      withheld: ["$.code", "$.data.items[].a.b", "$.data.items[].attrs.secret", "$.data.items[].other", "$.meta", "$.meta.count", "$.meta.internal"],
    },
    {
      label: "a quoted key containing a dot meets describeShape's collision spelling",
      collection: "$.data.items[*]",
      fields: [["name", "$['a.b']"]],
      withheld: ["$.code", "$.data.items[].attrs", "$.data.items[].attrs.name", "$.data.items[].attrs.secret", "$.data.items[].other", "$.data.items[].price", "$.data.items[].price.amount", "$.data.items[].price.cost", "$.meta", "$.meta.count", "$.meta.internal"],
    },
    {
      label: "a union and a wildcard",
      collection: "$.data.items[*]",
      fields: [["name", "$[other,attrs]"], ["price", "$.price.*"]],
      withheld: ["$.code", "$.data.items[].a.b", "$.meta", "$.meta.count", "$.meta.internal"],
    },
    {
      label: "recursive descent from the root, via extract",
      fields: [],
      extract: [["total", "$..count"]],
      withheld: ["$.code", "$.data", "$.data.items", "$.data.items[]", "$.data.items[].a.b", "$.data.items[].attrs", "$.data.items[].attrs.name", "$.data.items[].attrs.secret", "$.data.items[].other", "$.data.items[].price", "$.data.items[].price.amount", "$.data.items[].price.cost", "$.meta.internal"],
    },
  ];
  for (const c of cases) {
    it(`composes ${c.label}`, () => {
      const t = tool({
        response: c.fields.length ? { resource: "t.Stay", field: "stays", collection: c.collection, fields: c.fields.map(([name, path]) => ({ name, path })) } : undefined,
        extract: c.extract?.map(([name, path]) => ({ name, path })),
        contract: contractOf(body),
      });
      const withheld = withheldPaths(exposureOf(t, STAY_RESOURCE));
      const read = pathsTheRuntimeReads(t, STAY_RESOURCE, body);
      expect(read.length).toBeGreaterThan(0); // the oracle actually ran the path
      for (const p of read) expect(withheld).not.toContain(p);
      expect(withheld).toEqual(c.withheld);
    });
  }

  it("a mapping path the grammar cannot place exposes the whole body, never nothing", () => {
    const t = tool({
      response: { resource: "t.Stay", field: "stays", collection: "$.data.items[*]", fields: [{ name: "name", path: "$.attrs.^" }] },
      contract: contractOf(body),
    });
    expect(exposureOf(t, STAY_RESOURCE).withholds).toEqual([]);
    // A union member with a dot in it: jsonpath-plus reads `a.b` as one member, the shape spells
    // it as two steps — placed as everything rather than guessed.
    const union = tool({
      response: { resource: "t.Stay", field: "stays", collection: "$.data.items[*]", fields: [{ name: "name", path: "$[other,a.b]" }] },
      contract: contractOf(body),
    });
    for (const p of pathsTheRuntimeReads(union, STAY_RESOURCE, body)) expect(withheldPaths(exposureOf(union, STAY_RESOURCE))).not.toContain(p);
    expect(exposureOf(union, STAY_RESOURCE).withholds).toEqual([]);
  });
});

describe("exposureOf (ADD-309 D-6)", () => {
  const stay = { name: "A", price: 10, rating: 4, net: 7, supplier: { id: "s1", margin: 0.2 } };
  const body = { results: [stay], total: 1, debug: { traceId: "t" } };

  it("a mapped collection field: exposed as `<output>[].<field>`, via response", () => {
    const e = exposureOf(
      tool({
        response: { resource: "t.Stay", field: "stays", collection: "$.results[*]", fields: [{ name: "name", path: "$.name" }, { name: "price", path: "$.price" }, { name: "rating", path: "$.rating" }] },
        contract: contractOf(body),
      }),
      STAY_RESOURCE,
    );
    expect(e.exposes.filter((x) => x.path.startsWith("stays[]."))).toEqual([
      { path: "stays[].name", name: "name", type: { kind: "scalar", semantic: "text" }, required: true, via: "response" },
      { path: "stays[].price", name: "price", type: { kind: "scalar", semantic: "money" }, required: true, via: "response" },
      { path: "stays[].rating", name: "rating", type: { kind: "scalar", semantic: "quantity" }, required: false, via: "response" },
    ]);
    // The whole unmapped subtree is withheld, container and leaves alike; `$`, `$.results`
    // and `$.results[]` are the structure the mapped fields travel through, neither list's.
    expect(e.withholds).toEqual([
      { path: "$.debug", observed: "object" },
      { path: "$.debug.traceId", observed: "string" },
      { path: "$.results[].net", observed: "number" },
      { path: "$.results[].supplier", observed: "object" },
      { path: "$.results[].supplier.id", observed: "string" },
      { path: "$.results[].supplier.margin", observed: "number" },
      { path: "$.total", observed: "number" },
    ]);
    expect(e.observation).toEqual({ fixture: "fixtures/t.json", fingerprint: fingerprintShape(body) });
  });

  it("an extract scalar: exposed under its own name, via extract, and no longer withheld", () => {
    const e = exposureOf(
      tool({
        response: { resource: "t.Stay", field: "stays", collection: "$.results[*]", fields: [{ name: "name", path: "$.name" }] },
        extract: [{ name: "total", path: "$.total" }],
        contract: contractOf(body),
      }),
      STAY_RESOURCE,
    );
    expect(e.exposes.find((x) => x.name === "total")).toEqual({ path: "total", name: "total", type: { kind: "scalar", semantic: "quantity" }, required: true, via: "extract" });
    expect(withheldPaths(e)).not.toContain("$.total");
  });

  it("a declared-but-unmapped resource field: listed via unmapped, and its provider path withheld", () => {
    const e = exposureOf(
      tool({
        response: { resource: "t.Stay", field: "stays", collection: "$.results[*]", fields: [{ name: "name", path: "$.name" }, { name: "price", path: "$.price" }] },
        contract: contractOf(body),
      }),
      STAY_RESOURCE,
    );
    expect(e.exposes.find((x) => x.name === "rating")).toMatchObject({ path: "stays[].rating", via: "unmapped", required: false });
    // An output field no binding block fills is declared and never populated.
    expect(e.exposes.find((x) => x.name === "total")).toMatchObject({ path: "total", via: "unmapped" });
    expect(withheldPaths(e)).toContain("$.results[].rating");
  });

  it("no contract.shape: withholds is \"unknown\", never an empty list, and no observation", () => {
    const mapped = { resource: "t.Stay", field: "stays", collection: "$.results[*]", fields: [{ name: "name", path: "$.name" }] };
    const none = exposureOf(tool({ response: mapped }), STAY_RESOURCE);
    expect(none.withholds).toBe("unknown");
    expect(none).not.toHaveProperty("observation");
    // A pre-ADD-114 contract — fingerprint only — is no better: there is no shape to name.
    const hashOnly = exposureOf(tool({ response: mapped, contract: { fingerprint: "sha256:00", probeFixture: "f.json" } }), STAY_RESOURCE);
    expect(hashOnly.withholds).toBe("unknown");
    expect(hashOnly).not.toHaveProperty("observation");
  });

  it("a binding with neither response nor extract passes the body through: flagged, nothing withheld", () => {
    const e = exposureOf(tool({ contract: contractOf(body) }), STAY_RESOURCE);
    expect(e.passthrough).toBe(true);
    expect(e.withholds).toEqual([]);
    expect(exposureOf(tool({}), STAY_RESOURCE)).toMatchObject({ passthrough: true, withholds: "unknown" });
    // Unbound: not invocable, so nothing passes through.
    expect(exposureOf(tool({ connector: undefined }), STAY_RESOURCE)).not.toHaveProperty("passthrough");
  });

  it("an #81 error row's fields are exposed — its own map, or the same-named key", () => {
    const withErr = { results: [{ name: "A", price: 1, code: "E1", detail: "d" }] };
    const e = exposureOf(
      tool({
        response: {
          resource: "t.Stay",
          field: "stays",
          collection: "$.results[*]",
          fields: [{ name: "name", path: "$.name" }, { name: "price", path: "$.price" }],
          onError: { errorResource: "t.Failure", when: { path: "$.code", exists: true } },
        },
        contract: contractOf(withErr),
      }),
      STAY_RESOURCE,
    );
    expect(e.exposes.find((x) => x.name === "code")).toMatchObject({ path: "stays[].code", via: "response" });
    expect(e.withholds).toEqual([{ path: "$.results[].detail", observed: "string" }]);
  });

  it("receives: input names, types and required-ness, sorted", () => {
    expect(exposureOf(tool({}), STAY_RESOURCE).receives).toEqual([
      { name: "budget", type: { kind: "scalar", semantic: "money" }, required: false },
      { name: "where", type: { kind: "scalar", semantic: "location" }, required: true },
    ]);
  });

  it("names and types only — no value from the observed body appears", () => {
    const e = exposureOf(tool({ response: { resource: "t.Stay", field: "stays", collection: "$.results[*]", fields: [{ name: "name", path: "$.name" }] }, contract: contractOf(body) }), STAY_RESOURCE);
    const text = JSON.stringify(e);
    for (const v of ['"A"', '"s1"', '"t"', "0.2"]) expect(text).not.toContain(v);
  });
});

describe("exposureOfIR — tourism end to end", () => {
  const ir = compile(load(join(manifests, "tourism")));
  const [search] = exposureOfIR(ir);

  it("the Stay fields and totalMatches are exposed; the ADD-114 vocabulary is withheld", () => {
    expect(search.capabilityId).toBe("tourism.search");
    expect(search.exposes.filter((x) => x.via === "response").map((x) => x.path)).toEqual([
      "stays[].location",
      "stays[].name",
      "stays[].pricePerNight",
      "stays[].rating",
    ]);
    expect(search.exposes.filter((x) => x.via === "extract").map((x) => x.path)).toEqual(["totalMatches"]);
    expect(search.exposes.filter((x) => x.via === "unmapped")).toEqual([]);
    expect(search.withholds).toEqual([
      { path: "$.stays[].boardType", observed: "string" },
      { path: "$.stays[].commission", observed: "number" },
      { path: "$.stays[].freeCancellationUntil", observed: "string" },
      { path: "$.stays[].id", observed: "string" },
      { path: "$.stays[].net", observed: "number" },
      { path: "$.stays[].roomDescription", observed: "string" },
    ]);
    expect(search.observation).toEqual({ fixture: "fixtures/tourism.search.golden.json", fingerprint: ir.tools[0].contract!.fingerprint });
  });

  it("is sorted by capability id and deterministic across runs", () => {
    const bank = compile(load(join(manifests, "bank")));
    const ids = exposureOfIR(bank).map((e) => e.capabilityId);
    expect(ids).toEqual([...ids].sort());
    expect(JSON.stringify(exposureOfIR(bank))).toBe(JSON.stringify(exposureOfIR(compile(load(join(manifests, "bank"))))));
  });
});
