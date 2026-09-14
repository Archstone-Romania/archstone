import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiAdapter, skipsOperation, type ReasonCode } from "@archstone/init";

// Issue #63's own e2e document — `bookshelf.yaml` exercises exploded and non-exploded
// list-valued query parameters (Goal 1), a query parameter alongside a JSON body carrying an
// array-of-scalars property (Goal 2 + Goal 3), and both still-refused boundaries: a body
// property that is an array of objects (BR-9), and a path parameter whose schema is an array
// (query-location lists only).

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function read(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

const bookshelf = openApiAdapter.adapt({ origin: "bookshelf.yaml", document: read("bookshelf.yaml"), documents: {} });

function refusals(key: string): ReasonCode[] {
  const op = bookshelf.operations.find((o) => o.key === key)!;
  return op.notes.map((n) => n.code).filter(skipsOperation);
}

function detailOf(key: string): string {
  const op = bookshelf.operations.find((o) => o.key === key)!;
  return op.notes.filter((n) => skipsOperation(n.code)).map((n) => n.detail ?? "").join(" ");
}

describe("Bookshelf API (#63 e2e)", () => {
  it("declares exactly 6 operations", () => {
    expect(bookshelf.operations).toHaveLength(6);
  });

  it("4 of 6 operations are candidates — no refusal", () => {
    const candidates = bookshelf.operations.filter((o) => refusals(o.key).length === 0);
    expect(candidates).toHaveLength(4);
  });

  it("the 4 candidates are exactly the operations exercising Goals 1/2/3", () => {
    const expectedCandidates = [
      "GET /v1/books", // Goal 1: exploded list-valued query parameter
      "GET /v1/books/search", // Goal 1: non-exploded (comma-joined) list-valued query parameter
      "DELETE /v1/books/{id}", // an ordinary scalar query parameter
      "POST /v1/books/{id}/reviews", // Goal 2 + Goal 3: query param alongside a body with an array-of-scalars property
    ];
    const actual = bookshelf.operations.filter((o) => refusals(o.key).length === 0).map((o) => o.key);
    expect(actual.sort()).toEqual(expectedCandidates.sort());
  });

  it("POST /books/{id}/links refuses, naming `references` (array-of-objects body property)", () => {
    const key = "POST /v1/books/{id}/links";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(detailOf(key)).toMatch(/references/);
  });

  it("GET /books/batch/{isbns} refuses (list-valued path parameter)", () => {
    const key = "GET /v1/books/batch/{isbns}";
    expect(refusals(key)).toContain("unsupported-parameter-location");
    expect(detailOf(key)).toMatch(/isbns/);
  });
});
