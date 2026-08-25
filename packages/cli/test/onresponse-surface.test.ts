import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Issue #39 / ADD-31 (BR-13/S-US3.3/S-US6.3): `onResponse` is a programmatic-API-only,
// function-valued option — it MUST NEVER be reachable as a CLI flag on `archstone serve`,
// `archstone serve --http`, or `archstone verify`. Rather than spawn the CLI and try to prove
// a negative over the network, this asserts the structural fact directly against the source:
// the CLI binary itself never constructs an `invoke`/`opts` object containing `onResponse`,
// and its usage text advertises no such flag.

const here = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(resolve(here, "../src/index.ts"), "utf8");

describe("archstone CLI — no onResponse surface anywhere (#39)", () => {
  it("S-US3.3/S-US6.3: the CLI's source never references onResponse at all", () => {
    expect(cliSource).not.toMatch(/onResponse/);
  });

  it("serveStdio is called with no second argument (no invoke object at all) from `archstone serve`", () => {
    expect(cliSource).toMatch(/serveStdio\(dir\)/);
  });

  it("`archstone serve --http` constructs createHttpHandler with only { bearerToken }, no invoke", () => {
    expect(cliSource).toMatch(/createHttpHandler\(built\.registry,\s*\{\s*bearerToken:\s*token\s*\}\)/);
  });

  it("`archstone verify` calls runVerify with exactly 3 arguments — no 4th (opts) argument", () => {
    expect(cliSource).toMatch(/runVerify\(registry\.listCapabilities\(\),\s*dir,\s*registry\.ir\.resources\)/);
  });

  // #124 (ADD-124 D-3) added `--sandbox`, which needed a way into `runVerify`. This assertion
  // exists so that adding it did not quietly turn the assertion above into a claim about the
  // uncommon path only.
  //
  // The flag deliberately does NOT ride on `InvokeOptions` — it is a 5th parameter of a
  // purpose-built shape that cannot carry a callback by construction. So the `--sandbox` call
  // site passes a LITERAL `undefined` in the options slot, which is a stronger statement than
  // "3 arguments" was: the slot is visibly, explicitly empty rather than merely absent. Had the
  // flag been folded into `InvokeOptions`, this file's regex would have had to loosen to allow
  // a 4th argument, and it would have stopped protecting against a future callback riding along
  // on the same object.
  it("`archstone verify --sandbox` passes a literal `undefined` in the opts slot — the scope argument never becomes an options bag", () => {
    expect(cliSource).toMatch(
      /runVerify\(registry\.listCapabilities\(\),\s*dir,\s*registry\.ir\.resources,\s*undefined,\s*\{\s*includeNonRead:\s*true\s*\}\)/,
    );
  });

  it("the usage/help text advertises no --onResponse-style flag", () => {
    expect(cliSource).not.toMatch(/--on-?response/i);
  });
});
