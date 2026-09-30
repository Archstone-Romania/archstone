import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyResponseMapping } from "@archstone/emitter-support";
import { emit, locusCandidates, openApiAdapter, skipsOperation, type DecisionRecord, type DraftNode, type ReasonCode } from "@archstone/init";
import { commitFileSet } from "@archstone/init/loop";

// ADD-12 §8.1 / §8.4 item 1 in `init`: a list whose items are `oneOf[success, error]` under a
// `const` discriminator maps onto `resource` + `onError.errorResource` — and every OTHER
// two-branch `oneOf` is refused under the `oneof-*` code naming what the ratified form lacks.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/openapi/row-errors.yaml");

const draft = openApiAdapter.adapt({ origin: "row-errors.yaml", document: readFileSync(FIXTURE, "utf8"), documents: {} });

function op(key: string) {
  const found = draft.operations.find((o) => o.key === key);
  expect(found, `no operation keyed '${key}'`).toBeDefined();
  return found!;
}

function refusals(key: string): ReasonCode[] {
  return op(key).notes.map((n) => n.code).filter(skipsOperation);
}

function record(operation: string, capabilityId: string, responseLocus?: string): DecisionRecord {
  return {
    version: "0",
    company: { id: "acme", name: "Acme Pricing" },
    provider: "acme-api",
    decisions: [{ operation, keep: true, capabilityId, effect: "read", ...(responseLocus !== undefined ? { responseLocus } : {}) }],
  };
}

/** Emit one operation, compile the result with the real compiler, and hand back both. */
function emitAndCompile(operation: string, capabilityId: string, responseLocus?: string) {
  const emitted = emit(draft, record(operation, capabilityId, responseLocus));
  const workspace = mkdtempSync(join(tmpdir(), "archstone-init-row-errors-"));
  try {
    const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
    return { emitted, committed };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("the adapter lowers oneOf[success, error] list items to a success array plus rowErrors", () => {
  it("items are the SUCCESS object; the error half is stated structurally", () => {
    const response = op("GET /v1/prices").response;
    expect(response.kind).toBe("object");
    const items = (response as Extract<DraftNode, { kind: "object" }>).properties.find((p) => p.name === "items")!.node;
    expect(items.kind).toBe("array");
    const array = items as Extract<DraftNode, { kind: "array" }>;
    expect(array.items.kind).toBe("object");
    expect(array.rowErrors).toMatchObject({
      name: { derivation: "declared", value: "PriceError" },
      discriminator: { property: "status", equals: "error" },
      code: { name: "code", declaredRequired: { derivation: "declared", value: true } },
      message: { name: "msg", declaredRequired: { derivation: "declared", value: true } },
    });
    expect(refusals("GET /v1/prices")).toEqual([]);
  });

  it("the D-9 census sees an ordinary array of objects — the success row's fields only", () => {
    const census = locusCandidates(op("GET /v1/prices").response);
    expect(census.candidates.map((c) => [c.id, c.fields])).toEqual([["$.items[*]", ["sku", "amount", "currency"]]]);
  });
});

describe("GET /v1/prices — oneOf[Price, PriceError{status: const error, code, msg}]", () => {
  let result: ReturnType<typeof emitAndCompile>;
  beforeAll(() => {
    result = emitAndCompile("GET /v1/prices", "pricing.list-prices");
  });

  it("emits the binding's onError block: `when` from the const, `map` only for the diverging message", () => {
    const binding = result.emitted.files.get("bindings/pricing.list-prices.binding.yaml")!;
    expect(binding).toContain(
      [
        "    onError:",
        "      errorResource: pricing.PriceError",
        "      when:",
        '        path: "$.status"',
        "        equals: error",
        "      map:",
        '        message: "$.msg"  # declared #/components/schemas/PriceError/properties/msg — e.g. "No such SKU"',
      ].join("\n"),
    );
    // `code` reads from `$.code`, the mapper's default — so it is NOT restated.
    expect(binding).not.toMatch(/^\s+code: "\$\.code"/m);
  });

  it("emits a PriceError resource with exactly code and message", () => {
    const resource = result.emitted.files.get("pricing.PriceError.resource.yaml")!;
    expect(resource).toContain("name: pricing.PriceError");
    expect(resource).toContain(["  fields:", "    code:", "      type: string", "    message:", "      type: string"].join("\n"));
    expect(result.emitted.capabilities[0]).toMatchObject({ resource: "pricing.Price", errorResource: "pricing.PriceError" });
    expect(result.emitted.capabilities[0]!.files).toContain("pricing.PriceError.resource.yaml");
  });

  it("the manifest compiles with the real compiler, onError lowered into the IR", () => {
    expect(result.committed.failures).toEqual([]);
    expect(result.committed.ok).toBe(true);
    const tool = result.committed.ir!.tools.find((t) => t.id === "pricing.list-prices")!;
    expect(tool.response).toMatchObject({
      resource: "pricing.Price",
      collection: "$.items[*]",
      onError: { errorResource: "pricing.PriceError", when: { path: "$.status", equals: "error" }, map: [{ name: "message", path: "$.msg" }] },
    });
    expect(result.committed.ir!.resources["pricing.PriceError"]!.map((f) => [f.name, f.required])).toEqual([
      ["code", true],
      ["message", true],
    ]);
  });

  it("end to end: a mixed batch maps valid rows as ok and error rows as error, with code and message", () => {
    const ir = result.committed.ir!;
    const tool = ir.tools.find((t) => t.id === "pricing.list-prices")!;
    const body = {
      items: [
        { sku: "SKU-1", amount: 12.5, currency: "EUR" },
        { status: "error", code: "UNKNOWN_SKU", msg: "No such SKU: SKU-2" },
        { sku: "SKU-3", amount: 3, currency: "EUR" },
        { status: "error", code: "DISCONTINUED", msg: "SKU-4 is no longer sold" },
      ],
    };
    const mapped = applyResponseMapping(tool, body, ir.resources);
    expect(mapped.status).toBe("ok");
    expect(mapped.rowViolations).toBeUndefined();
    expect(mapped.data).toEqual({
      prices: [
        { $row: "ok", sku: "SKU-1", amount: 12.5, currency: "EUR" },
        { $row: "error", code: "UNKNOWN_SKU", message: "No such SKU: SKU-2" },
        { $row: "ok", sku: "SKU-3", amount: 3, currency: "EUR" },
        { $row: "error", code: "DISCONTINUED", message: "SKU-4 is no longer sold" },
      ],
    });
  });
});

describe("the code/message variants", () => {
  it("an error branch declaring `code` and `message` itself needs no `map`", () => {
    const { emitted, committed } = emitAndCompile("GET /v1/quotes", "pricing.list-quotes");
    expect(committed.ok).toBe(true);
    const binding = emitted.files.get("bindings/pricing.list-quotes.binding.yaml")!;
    expect(binding).toContain(["    onError:", "      errorResource: pricing.QuoteError", "      when:", '        path: "$.status"', "        equals: error"].join("\n"));
    const onError = binding.slice(binding.indexOf("onError:"));
    expect(onError).not.toMatch(/^\s+map:/m);
    const tool = committed.ir!.tools.find((t) => t.id === "pricing.list-quotes")!;
    expect(tool.response?.onError?.map).toBeUndefined();
    const mapped = applyResponseMapping(tool, [{ sku: "A", amount: 1 }, { status: "error", code: "E1", message: "nope" }], committed.ir!.resources);
    expect(mapped.data).toEqual({ quotes: [{ $row: "ok", sku: "A", amount: 1 }, { $row: "error", code: "E1", message: "nope" }] });
  });

  it("an error branch without `code` reads code from the discriminator's own path", () => {
    const { emitted, committed } = emitAndCompile("GET /v1/stocks", "stock.list-stocks");
    expect(committed.failures).toEqual([]);
    const binding = emitted.files.get("bindings/stock.list-stocks.binding.yaml")!;
    expect(binding).toMatch(/onError:\n\s+errorResource: stock\.StockError\n\s+when:\n\s+path: "\$\.kind"\n\s+equals: failed\n\s+map:\n\s+code: "\$\.kind".*\n\s+message: "\$\.reason"/);
    const tool = committed.ir!.tools.find((t) => t.id === "stock.list-stocks")!;
    const mapped = applyResponseMapping(tool, { results: [{ warehouse: "W1", units: 4 }, { kind: "failed", reason: "offline" }] }, committed.ir!.resources);
    expect(mapped.status).toBe("ok");
    expect(mapped.data).toEqual({ stocks: [{ $row: "ok", warehouse: "W1", units: 4 }, { $row: "error", code: "failed", message: "offline" }] });
  });

  it("a numeric discriminator standing in as the code keeps its type — `equals: 7`, `code: quantity`", () => {
    // The mapper copies values without checking types, but the MCP `outputSchema` does not: a
    // number under `type: string` would fail a client validating `structuredContent`. So the
    // code's semantic type follows the source's value, not a fixed `string`.
    const { emitted, committed } = emitAndCompile("GET /v1/levels", "stock.list-levels");
    expect(committed.failures).toEqual([]);
    const binding = emitted.files.get("bindings/stock.list-levels.binding.yaml")!;
    expect(binding).toContain('        path: "$.errno"\n        equals: 7');
    expect(committed.ir!.resources["stock.QuoteError"]!.find((f) => f.name === "code")!.type).toMatchObject({ kind: "scalar", semantic: "quantity" });
    const tool = committed.ir!.tools.find((t) => t.id === "stock.list-levels")!;
    const mapped = applyResponseMapping(tool, [{ errno: 7, message: "bin locked" }, { errno: 8, sku: "B", amount: 2 }], committed.ir!.resources);
    expect(mapped.data).toEqual({ quotes: [{ $row: "error", code: 7, message: "bin locked" }, { $row: "ok", sku: "B", amount: 2 }] });
  });
});

describe("refusals — each names what the ratified form lacks, and none is unsupported-composition", () => {
  const cases: Array<[string, ReasonCode]> = [
    ["GET /v1/too-many", "oneof-too-many-branches"],
    ["GET /v1/no-discriminator", "oneof-no-discriminator"],
    ["GET /v1/both-pinned", "oneof-no-discriminator"],
    ["GET /v1/two-consts", "oneof-no-discriminator"],
    ["GET /v1/object-const", "oneof-no-discriminator"],
    ["GET /v1/scalar-branch", "oneof-non-object-branch"],
    ["GET /v1/message-ambiguous", "oneof-error-fields-unresolved"],
    ["GET /v1/message-missing", "oneof-error-fields-unresolved"],
    ["GET /v1/boolean-code", "oneof-error-fields-unresolved"],
    ["GET /v1/root-union", "oneof-outside-collection"],
    ["GET /v1/property-union", "oneof-outside-collection"],
  ];

  for (const [key, code] of cases) {
    it(`${key} → ${code}, and the operation emits nothing`, () => {
      expect(refusals(key)).toEqual([code]);
      const result = emit(draft, record(key, "pricing.refused"));
      expect(result.skipped).toMatchObject([{ operation: key, code }]);
      expect(result.skipped.map((s) => s.code)).not.toContain("unsupported-composition");
      expect(result.files.size).toBe(0);
    });
  }

  it("a oneOf[success, error] list nested INSIDE the item locus → oneof-outside-collection", () => {
    // The adapter accepts the union where it stands (a list's items); only the emitter knows it
    // is not the collection being mapped. Mapping the baskets without it would flatten nothing
    // visible — but the union would be silently lost from the capability's contract.
    expect(refusals("GET /v1/nested-union")).toEqual([]);
    const result = emit(draft, record("GET /v1/nested-union", "pricing.list-baskets"));
    expect(result.skipped).toMatchObject([{ code: "oneof-outside-collection" }]);
    expect(result.files.size).toBe(0);
  });

  it("the ROOT locus chosen over a oneOf[success, error] list → oneof-outside-collection", () => {
    const result = emit(draft, record("GET /v1/paged-prices", "pricing.page-prices", "root"));
    expect(result.skipped).toMatchObject([{ code: "oneof-outside-collection" }]);
    expect(result.skipped[0]!.detail).toMatch(/the locus is 'root'/);
  });

  it("the same response with the list chosen emits onError normally", () => {
    const { emitted, committed } = emitAndCompile("GET /v1/paged-prices", "pricing.page-prices", "$.items[*]");
    expect(committed.ok).toBe(true);
    expect(emitted.files.get("bindings/pricing.page-prices.binding.yaml")).toContain("errorResource: pricing.PriceError");
  });

  it("`<Success>Error` already claimed with a different field set → resource-name-conflict, never a suffix", () => {
    // `GET /v1/price-errors` returns the PriceError component itself, so it claims
    // `pricing.PriceError` with status/code/msg first; the union's code/message cannot share it.
    const result = emit(draft, {
      ...record("GET /v1/price-errors", "pricing.last-error"),
      decisions: [
        { operation: "GET /v1/price-errors", keep: true, capabilityId: "pricing.last-error", effect: "read" },
        { operation: "GET /v1/prices", keep: true, capabilityId: "pricing.list-prices", effect: "read" },
      ],
    });
    expect(result.capabilities.map((c) => c.capabilityId)).toEqual(["pricing.last-error"]);
    expect(result.skipped).toMatchObject([{ capabilityId: "pricing.list-prices", code: "resource-name-conflict" }]);
    expect([...result.files.keys()].filter((p) => p.includes("list-prices"))).toEqual([]);
  });

  it("two capabilities over the same union share Price and PriceError, as any equal resource is shared", () => {
    const result = emit(draft, {
      ...record("GET /v1/prices", "pricing.list-prices"),
      decisions: [
        { operation: "GET /v1/prices", keep: true, capabilityId: "pricing.list-prices", effect: "read" },
        { operation: "GET /v1/paged-prices", keep: true, capabilityId: "pricing.page-prices", effect: "read", responseLocus: "$.items[*]" },
      ],
    });
    expect(result.skipped).toEqual([]);
    expect([...result.files.keys()].filter((p) => p.endsWith(".resource.yaml")).sort()).toEqual(["pricing.Price.resource.yaml", "pricing.PriceError.resource.yaml"]);
  });
});

describe("regressions — what this does NOT widen", () => {
  it("the nullability idiom on list items still reduces, with no rowErrors", () => {
    expect(refusals("GET /v1/nullable-rows")).toEqual([]);
    const response = op("GET /v1/nullable-rows").response;
    expect(response.kind).toBe("array");
    const array = response as Extract<DraftNode, { kind: "array" }>;
    expect(array.items.kind).toBe("object");
    expect(array.rowErrors).toBeUndefined();
  });

  it("anyOf over the same two branches is still unsupported-composition", () => {
    expect(refusals("GET /v1/any-of")).toEqual(["unsupported-composition"]);
  });
});
