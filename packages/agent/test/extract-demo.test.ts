// #13 / ADR-0011 — the example is executed, not merely shipped.
//
// A guarantee nobody can run is a claim. This spawns `examples/demo/extract-stay` as a real
// process and asserts what it prints, so the demo cannot rot into a file that no longer works
// while the docs go on describing it. It resolves the tourism manifest and the built
// `@archstone/agent` the same way a reader would, which is the point of running it rather than
// importing its internals.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demo = resolve(here, "../../../examples/demo/extract-stay/extract-stay.mjs");

let output: string;

beforeAll(() => {
  // No network, no API key: the model responses are recorded in the script itself.
  output = execFileSync(process.execPath, [demo], { encoding: "utf8", timeout: 60_000 });
});

describe("#13: the extraction demo runs and shows all three outcomes", () => {
  it("ok — every declared field present", () => {
    expect(output).toMatch(/every declared field, well-shaped\n\s+status:\s+ok/);
  });

  it("degraded — the absent optional is named, and the rest is still returned", () => {
    expect(output).toMatch(/the optional `rating` is absent\n\s+status:\s+degraded\n\s+degraded:\s+rating/);
    expect(output).toMatch(/"pricePerNight":320/);
  });

  it("violation — the document is withheld whole", () => {
    expect(output).toMatch(
      /the required `pricePerNight` is absent\n\s+status:\s+violation\n\s+missing:\s+pricePerNight\n\s+data:\s+\(withheld\)/,
    );
  });
});

describe("#13: the undeclared key — the record's central claim, made visible", () => {
  it("is dropped from data and named", () => {
    expect(output).toMatch(/undeclared:\s+confidence/);
    // …and the whole run never once prints it as part of a returned document.
    const dataLines = output.split("\n").filter((l) => l.trimStart().startsWith("data:"));
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines) expect(line).not.toContain("confidence");
  });
});

describe("#13: the demo states what validation does not prove", () => {
  it("says so in its own output, not only in its README", () => {
    expect(output).toContain("It does not mean the answer is true");
  });

  it("shows the schema it hands the model is closed", () => {
    expect(output).toContain('"additionalProperties": false');
  });
});
