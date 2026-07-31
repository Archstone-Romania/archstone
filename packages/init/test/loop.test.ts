import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emit, type DecisionRecord } from "@archstone/init";
import { commitFileSet, compileManifest } from "@archstone/init/loop";
import { arrayOf, draftModel, inputField, objectNode, operation, property, scalarNode } from "./draft";

// ADD-37 §6 step 3. Two terminal states, and nothing in between:
//     a compiling manifest was written   |   nothing was written, and here is why
// Every refusal test below asserts the SECOND half explicitly — that the target directory is
// untouched — because "reported an error AND left three files behind" is the failure mode a
// developer would discover by committing them.

let workspace: string;
let target: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "archstone-init-test-"));
  target = join(workspace, "capabilities");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const listOperation = operation("GET", "/api/v1/parts", {
  description: "List the parts Acme can supply.",
  response: objectNode([
    property(
      "items",
      arrayOf(
        objectNode(
          [
            property("id", scalarNode({ type: "identifier", example: "P-1" }), { declaredRequired: true }),
            property("name", scalarNode({ type: "text", example: "Bracket" }), { declaredRequired: true }),
            property("pricePerUnit", scalarNode({ type: "quantity", nullable: true }), { declaredRequired: true }),
          ],
          { name: "Part" },
        ),
      ),
    ),
  ]),
});

const priceOperation = operation("GET", "/api/v1/parts/{partId}/price", {
  description: "Estimate the price of one part.",
  input: [
    inputField("partId", "path", { type: "identifier" }),
    inputField("widthCm", "query", { type: "quantity", wireName: "width_cm" }),
  ],
  response: objectNode([property("currency", scalarNode({ type: "string" }), { declaredRequired: true })], { name: "PartPriceEstimate" }),
});

const record: DecisionRecord = {
  version: "0",
  company: { id: "acme", name: "Acme Parts" },
  decisions: [
    { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
    { operation: "GET /api/v1/parts/{partId}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
  ],
};

function goodFileSet(): Map<string, string> {
  const result = emit(draftModel([listOperation, priceOperation]), record);
  expect(result.files.size).toBeGreaterThan(0);
  return result.files;
}

describe("the loop — success commits", () => {
  it("writes the manifest and returns the IR the real compiler produced from it", () => {
    const result = commitFileSet(goodFileSet(), { targetDir: target });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(readdirSync(target).sort()).toEqual([
      "bindings",
      "capabilities.yaml",
      "catalog.Part.resource.yaml",
      "catalog.PartPriceEstimate.resource.yaml",
      "catalog.estimate-part-price.capability.yaml",
      "catalog.list-parts.capability.yaml",
    ]);
    expect(result.ir?.tools.map((t) => t.id).sort()).toEqual(["catalog.estimate-part-price", "catalog.list-parts"]);
  });

  it("commits the exact bytes that compiled — the target is a copy of the validated temp dir", () => {
    const files = goodFileSet();
    commitFileSet(files, { targetDir: target });
    for (const [relative, content] of files) {
      expect(readFileSync(join(target, relative), "utf8")).toBe(content);
    }
  });

  it("the compiled IR shows the three non-emissions taking effect (Challenge 2), not just the YAML", () => {
    const result = commitFileSet(goodFileSet(), { targetDir: target });
    for (const tool of result.ir!.tools) {
      // No `lifecycle:` key ⇒ the compiler's default. `experimental` would have hidden the tool
      // from `tools/list` entirely.
      expect(tool.lifecycle).toBe("stable");
      // No `policies:` ⇒ nothing for the policy evaluator to gate on, so `serve`/`verify` — which
      // have no caller-injection surface — can actually invoke it.
      expect(tool.policies).toEqual([]);
      // No `contract:` ⇒ `verify` reports it as unverified, never as green against a fiction.
      expect(tool.contract).toBeUndefined();
    }
  });

  it("refuses a non-empty target without force, and overwrites with it", () => {
    expect(commitFileSet(goodFileSet(), { targetDir: target }).ok).toBe(true);
    writeFileSync(join(target, "notes.md"), "a file the developer wrote");

    const second = commitFileSet(goodFileSet(), { targetDir: target });
    expect(second.ok).toBe(false);
    expect(second.failures[0]!.code).toBe("target-not-empty");
    expect(existsSync(join(target, "notes.md"))).toBe(true);

    expect(commitFileSet(goodFileSet(), { targetDir: target, force: true }).ok).toBe(true);
  });
});

describe("the loop — refusals leave the target untouched", () => {
  it("a manifest that fails the SHAPE check writes nothing", () => {
    const broken = new Map([
      ["capabilities.yaml", "company:\n  id: acme\ncapabilities:\n  - catalog.list-parts\nproviders:\n  - acme-api\n"],
      // `effect: browse` is not in the CDL enum.
      ["catalog.list-parts.capability.yaml", "capability:\n  id: catalog.list-parts\n  description: List parts.\n  effect: browse\n  provider: acme-api\n"],
    ]);
    const result = commitFileSet(broken, { targetDir: target });
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.failures.some((f) => f.code === "shape-invalid")).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("a manifest that fails the SEMANTIC check writes nothing", () => {
    // Shape-valid everywhere, but the output references a resource no file defines.
    const broken = new Map([
      ["capabilities.yaml", "company:\n  id: acme\ncapabilities:\n  - catalog.list-parts\nproviders:\n  - acme-api\n"],
      [
        "catalog.list-parts.capability.yaml",
        "capability:\n  id: catalog.list-parts\n  description: List parts.\n  effect: read\n  output:\n    parts:\n      collection: catalog.Missing\n  provider: acme-api\n",
      ],
    ]);
    const result = commitFileSet(broken, { targetDir: target });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "semantic-error")).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("unparseable YAML writes nothing", () => {
    const broken = new Map([["capabilities.yaml", "company:\n  id: acme\n : : :\n"]]);
    const result = commitFileSet(broken, { targetDir: target });
    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("an empty file set is a refusal, never an empty manifest", () => {
    const result = commitFileSet(new Map(), { targetDir: target });
    expect(result.failures[0]!.code).toBe("empty-file-set");
    expect(existsSync(target)).toBe(false);
  });

  it("a path that would escape the target is refused before anything is written", () => {
    const result = commitFileSet(new Map([["../escaped.yaml", "x: 1\n"]]), { targetDir: target });
    expect(result.failures[0]!.code).toBe("unsafe-path");
    expect(existsSync(join(workspace, "escaped.yaml"))).toBe(false);
  });

  it("leaves no temp directory behind, on success or on refusal", () => {
    const tmpRoot = mkdtempSync(join(workspace, "tmproot-"));
    commitFileSet(goodFileSet(), { targetDir: target, tmpRoot });
    commitFileSet(new Map([["capabilities.yaml", "nope\n"]]), { targetDir: join(workspace, "other"), tmpRoot });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

describe("the loop — parity with the rest of the toolchain", () => {
  it("compiles a real shipped manifest through the same pipeline `apply` uses", () => {
    const result = compileManifest("examples/manifests/tourism");
    expect(result.ok).toBe(true);
    expect(result.ir?.tools.map((t) => t.id)).toEqual(["tourism.search"]);
  });

  it("refuses two candidates confirmed under the same capability id, before any write", () => {
    // NOTE on the tool-name-collision arm (ADD-30 D-2), which `compileManifest` also gates on:
    // it is NOT reachable from a shape-valid manifest today, and the test that would drive it
    // cannot be written. `toolName()` rewrites only `.` → `_`, and a CDL id may not contain
    // `_` at all, so the sanitizer is injective over the id alphabet — two distinct legal ids
    // can never share an advertised name. The check stays for parity with `apply`/`build` and
    // as defence in depth if the id grammar ever widens; the REACHABLE version of "two
    // candidates that would become the same tool" is this one, refused at emission.
    const second = operation("GET", "/api/v1/parts/all", { description: "Also list parts." });
    const result = emit(draftModel([listOperation, second]), {
      ...record,
      decisions: [
        { operation: "GET /api/v1/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
        { operation: "GET /api/v1/parts/all", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
      ],
    });
    expect(result.skipped.map((s) => s.code)).toEqual(["capability-id-conflict"]);
    const committed = commitFileSet(result.files, { targetDir: target });
    expect(committed.ok).toBe(true);
    expect(committed.ir!.tools).toHaveLength(1);
  });
});

describe("the loop — force commits a UNION, so the union is what gets compiled", () => {
  it("refuses when a leftover file from an earlier run would break the manifest it merges into", () => {
    expect(commitFileSet(goodFileSet(), { targetDir: target }).ok).toBe(true);
    // The shape of a real second run: the human declined a capability this time, so nothing
    // overwrites the file the previous run left — and that file references a resource that is
    // no longer emitted.
    const stale = join(target, "catalog.stale.capability.yaml");
    writeFileSync(
      stale,
      "capability:\n  id: catalog.stale\n  description: Left over from an earlier run.\n  effect: read\n  output:\n    x:\n      collection: catalog.Gone\n  provider: acme-api\n",
    );

    const forced = commitFileSet(goodFileSet(), { targetDir: target, force: true });
    expect(forced.ok, "the target would not compile after the merge, so nothing may be written").toBe(false);
    expect(forced.written).toEqual([]);
    expect(forced.failures.some((f) => f.code === "semantic-error")).toBe(true);
    // And the developer's directory is exactly as they left it.
    expect(existsSync(stale)).toBe(true);
  });

  it("commits when the merge does compile, and the committed target compiles as a whole", () => {
    expect(commitFileSet(goodFileSet(), { targetDir: target }).ok).toBe(true);
    writeFileSync(join(target, "README.md"), "notes the developer keeps beside the manifest\n");
    expect(commitFileSet(goodFileSet(), { targetDir: target, force: true }).ok).toBe(true);
    expect(compileManifest(target).ok).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });
});
