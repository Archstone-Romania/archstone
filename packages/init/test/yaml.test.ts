import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { YamlWriter, yamlScalar } from "../src/yaml";

// The writer is small and hand-rolled (see its header for why), so the thing that makes it
// safe is this file: every string it can be handed must come back out of a REAL YAML parser —
// the same one `@archstone/schema`'s loader uses — as the identical string. Resource field
// names and descriptions come from a stranger's payload, so "nobody would write that" is not
// an argument available here.

const NASTY = [
  "plain",
  "with: a colon",
  "trailing space ",
  " leading space",
  "hash # inside",
  // Found by fuzzing this function against the real parser: rendered plain, `key: foo:` is a
  // nested mapping, not a string, and the document does not parse at all.
  "foo:",
  "a:",
  "ends:with:colon:",
  "single char :",
  ":",
  "http://example.test/x",
  "a:b:c",
  "Note: read this",
  "#leading hash",
  "quote \" inside",
  "back\\slash",
  "line\nbreak",
  "tab\tseparated",
  "true",
  "false",
  "null",
  "yes",
  "no",
  "~",
  "12",
  "12.5",
  "-3",
  "0x1f",
  "$.items[*]",
  "${ACME_API_URL}",
  "[bracketed]",
  "{braced}",
  "a, b, c",
  "- dashed",
  "@at",
  "`backtick",
  "*star",
  "&anchor",
  "!bang",
  "|pipe",
  ">gt",
  "'single'",
  "emoji ✅ and é accents",
  "",
];

describe("yamlScalar — every string round-trips as itself", () => {
  for (const value of NASTY) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      expect(parse(`key: ${yamlScalar(value)}\n`)).toEqual({ key: value });
    });
  }

  it("round-trips numbers and booleans as numbers and booleans", () => {
    expect(parse(`a: ${yamlScalar(12.5)}\nb: ${yamlScalar(true)}\nc: ${yamlScalar(0)}\n`)).toEqual({ a: 12.5, b: true, c: 0 });
  });
});

describe("yamlScalar — a plain scalar is only chosen when nothing else can be read", () => {
  it("quotes every colon, because the rule with exceptions is the one that breaks", () => {
    for (const value of ["foo:", "a:b", "http://x", ":"]) {
      expect(yamlScalar(value)).toBe(JSON.stringify(value));
    }
  });
});

describe("YamlWriter", () => {
  it("nests blocks, quotes keys that need it, and keeps comments out of the data", () => {
    const w = new YamlWriter();
    w.comment("a header");
    w.blank();
    w.block("resource", (rw) => {
      rw.entry("name", "catalog.Part");
      rw.block("fields", (fw) => {
        fw.block("odd: key", (kw) => {
          kw.entry("type", "string");
          kw.entry("required", false);
          kw.comment("why it is optional");
        });
      });
    });
    const text = w.toString();
    expect(parse(text)).toEqual({ resource: { name: "catalog.Part", fields: { "odd: key": { type: "string", required: false } } } });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("keeps a trailing comment out of the value", () => {
    const w = new YamlWriter();
    w.entry("path", "$.name", 'declared Part.name — e.g. "Bracket"');
    expect(parse(w.toString())).toEqual({ path: "$.name" });
  });

  it("never lets a newline in a comment escape the comment", () => {
    const w = new YamlWriter();
    w.comment("first\ninjected: value");
    w.entry("real", "x");
    expect(parse(w.toString())).toEqual({ real: "x" });
  });

  it("renders a closed value set in flow style, as the hand-written manifests do", () => {
    const w = new YamlWriter();
    w.flowList("values", ["steel", "aluminium"]);
    expect(parse(w.toString())).toEqual({ values: ["steel", "aluminium"] });
  });
});
