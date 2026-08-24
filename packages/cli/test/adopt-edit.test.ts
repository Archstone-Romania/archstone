import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAdoption, applyContractRecording, type AdoptionEdit } from "../src/adopt-edit";

const root = resolve(__dirname, "../../..");
const resourceYaml = readFileSync(resolve(root, "examples/manifests/tourism/tourism.Stay.resource.yaml"), "utf8");
const bindingYaml = readFileSync(resolve(root, "examples/manifests/tourism/bindings/tourism.search.binding.yaml"), "utf8");

const boardType: AdoptionEdit = {
  field: "boardType",
  itemPath: "$.boardType",
  semantic: "text",
  description: "What the rate includes — ROOM_ONLY, BREAKFAST, HALF_BOARD or ALL_INCLUSIVE.",
};

function ok(r: ReturnType<typeof applyAdoption>) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.problem}`);
  return r;
}

describe("applyAdoption — a review surface survives the edit (ADD-117)", () => {
  it("appends the field to the resource, with required:false and the human's description", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, [boardType]));
    expect(r.resource).toContain("    boardType:\n      type: text\n      required: false\n      description:");
    expect(r.resource).toContain("ROOM_ONLY, BREAKFAST, HALF_BOARD or ALL_INCLUSIVE.");
  });

  it("appends the JSONPath to the binding's response map, quoted like its neighbours", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, [boardType]));
    expect(r.binding).toContain('      boardType: "$.boardType"');
  });

  it("changes NOTHING else — every original line survives, in order", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, [boardType]));
    for (const [before, after] of [
      [resourceYaml, r.resource],
      [bindingYaml, r.binding],
    ]) {
      const originals = before.split("\n");
      const result = after.split("\n");
      // Every original line still present, in the same relative order: the appended lines are
      // the only difference. This is the property the whole module exists for — a comment lost
      // here is a comment a human wrote about their own business.
      let cursor = 0;
      for (const line of originals) {
        const at = result.indexOf(line, cursor);
        expect(at, `original line vanished or moved: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(cursor);
        cursor = at + 1;
      }
    }
  });

  it("keeps every comment the human wrote", () => {
    const comments = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("#"));
    const r = ok(applyAdoption(resourceYaml, bindingYaml, [boardType]));
    expect(comments(r.resource)).toEqual(comments(resourceYaml));
    expect(comments(r.binding)).toEqual(comments(bindingYaml));
  });

  it("appends inside the block, not after the blank line that ends it", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, [boardType]));
    const lines = r.binding.split("\n");
    const mapIdx = lines.findIndex((l) => l.trim() === "map:");
    const addedIdx = lines.findIndex((l) => l.includes("boardType:"));
    // Nothing but map entries between the header and the new line.
    for (let i = mapIdx + 1; i < addedIdx; i++) {
      expect(lines[i].trim()).toMatch(/^[A-Za-z]/);
    }
  });

  it("applies several fields in one pass", () => {
    const r = ok(
      applyAdoption(resourceYaml, bindingYaml, [
        boardType,
        { field: "distanceToBeachM", itemPath: "$.distanceToBeachM", semantic: "quantity", description: "Metres to the nearest beach." },
      ]),
    );
    expect(r.resource).toContain("    distanceToBeachM:");
    expect(r.binding).toContain('      distanceToBeachM: "$.distanceToBeachM"');
  });

  it("quotes a description that would otherwise break the document", () => {
    const r = ok(
      applyAdoption(resourceYaml, bindingYaml, [
        { ...boardType, description: "Board: what it includes # and a hash" },
      ]),
    );
    expect(r.resource).toContain('description: "Board: what it includes # and a hash"');
  });

  it("is a no-op for no edits", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, []));
    expect(r.resource).toBe(resourceYaml);
    expect(r.binding).toBe(bindingYaml);
  });

  it("refuses rather than guessing when the block is missing", () => {
    const r = applyAdoption("resource:\n  name: tourism.Stay\n", bindingYaml, [boardType]);
    expect(r).toEqual({ ok: false, problem: expect.stringContaining("could not find a 'fields:' block") });
  });

  it("refuses rather than guessing when a block is ambiguous", () => {
    const twoMaps = bindingYaml.replace("  contract:", "  response:\n    map:\n      x: \"$.x\"\n\n  contract:");
    const r = applyAdoption(resourceYaml, twoMaps, [boardType]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("refusing to guess");
  });
});

describe("applyContractRecording — one response, one contract (ADD-117 R-4)", () => {
  const shape = { $: "object", "$.stays": "array", "$.stays[]": "object", "$.stays[].boardType": "string" };

  it("replaces the fingerprint and the whole shape block, rather than accumulating", () => {
    const first = applyContractRecording(bindingYaml, "sha256:" + "a".repeat(64), shape);
    if (!first.ok) throw new Error(first.problem);
    const second = applyContractRecording(first.binding, "sha256:" + "b".repeat(64), { ...shape, "$.stays[].net": "number" });
    if (!second.ok) throw new Error(second.problem);
    expect(second.binding.match(/^\s*shape:$/gm)).toHaveLength(1);
    expect(second.binding).toContain("sha256:" + "b".repeat(64));
    expect(second.binding).not.toContain("sha256:" + "a".repeat(64));
    expect(second.binding).toContain('"$.stays[].net": number');
  });

  it("quotes every path key, so a JSONPath never reads as structure", () => {
    const r = applyContractRecording(bindingYaml, "sha256:" + "c".repeat(64), shape);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding).toContain('"$.stays[].boardType": string');
    expect(r.binding).toContain('"$": object');
  });

  it("keeps the human's comments around the contract block", () => {
    const before = bindingYaml.split("\n").filter((l) => l.trim().startsWith("#"));
    const r = applyContractRecording(bindingYaml, "sha256:" + "d".repeat(64), shape);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding.split("\n").filter((l) => l.trim().startsWith("#"))).toEqual(before);
  });

  it("refuses a binding with no contract to update", () => {
    const r = applyContractRecording("binding:\n  capabilityId: x\n", "sha256:" + "e".repeat(64), shape);
    expect(r).toEqual({ ok: false, problem: expect.stringContaining("no contract fingerprint") });
  });
});
