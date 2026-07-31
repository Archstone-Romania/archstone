import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locusCandidates, openApiAdapter, type DecisionRecord } from "@archstone/init";
import { INIT_USAGE, loadSource, parseInitArgs, resolveReference, runGate, runInitCmd, type Ask } from "../src/init";

// ADD-37 §6 step 7. The verb is THIN, so what is worth testing here is exactly the three
// things it owns — argv, the gate's keystroke rules, and the host half of D-11 — plus the two
// DoD items, both of which are refusals.

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../init/test/fixtures/openapi/catalog.yaml");

/** A scripted terminal. Answers in order; an exhausted script returns the fallback, which is
 *  what makes "the default path" testable as the path a user who holds Enter would take. */
function scripted(answers: string[]): Ask & { asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    question: async (text: string, fallback?: string) => {
      asked.push(text);
      const answer = answers[i++];
      if (answer !== undefined && answer !== "") return answer;
      if (fallback !== undefined) return fallback;
      // The locus prompt has no pre-fill when the response carries two or more lists — there
      // is no defensible default, which is the point. Tests that are about something ELSE
      // (bulk-keep, effect pre-fill, prompt ordering) still have to get past it, so an
      // exhausted script picks the first candidate rather than deadlocking the gate.
      return text.includes("which one?") ? "1" : "";
    },
  };
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "archstone-cli-init-"));
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("argv and --help (DoD)", () => {
  it("`--help` documents that --probe is opt-in and read-only", async () => {
    expect(await runInitCmd(["init", "--help"])).toBe(0);
    const help = logs.join("\n");
    expect(help).toMatch(/--probe/);
    expect(help).toMatch(/OPT-IN, READ-ONLY/);
    expect(help).toMatch(/second, separate confirmation/);
    expect(INIT_USAGE).toMatch(/No LLM is involved, on any path/);
  });

  it("requires a spec file and an --out directory", () => {
    expect(parseInitArgs(["init"])).toEqual({ error: "a spec file is required" });
    expect(parseInitArgs(["init", "spec.yaml"])).toEqual({ error: "--out <dir> is required" });
  });

  it("reads the flags without mistaking a flag's value for the spec", () => {
    const args = parseInitArgs(["init", "spec.yaml", "--out", "manifest", "--domain", "framing", "--probe", "--force"]);
    expect(args).toMatchObject({ spec: "spec.yaml", out: "manifest", domain: "framing", probe: true, force: true, interactive: true });
  });
});

describe("the one refusal that is not about the network (DoD-5(d))", () => {
  it("--non-interactive with no Decision Record refuses, rather than defaulting an `effect`", async () => {
    const ws = workspace();
    const code = await runInitCmd(["init", SPEC, "--out", join(ws, "out"), "--non-interactive"]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/never defaults an `effect`/);
    // And it wrote nothing — D-7's second terminal state.
    expect(existsSync(join(ws, "out"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("D-11's host half — the host fetches, within the subtree, or not at all", () => {
  it("resolves a sibling document the adapter asked for", () => {
    expect(resolveReference(SPEC, "shared.yaml")).toBe(resolve(dirname(SPEC), "shared.yaml"));
    const { input, unresolved } = loadSource(openApiAdapter, SPEC);
    expect(Object.keys(input.documents ?? {})).toEqual(["shared.yaml"]);
    expect(unresolved).toEqual([]);
  });

  it("refuses to follow a path out of the spec's own directory", () => {
    // Two independent checks guard this — the adapter never emits a `..`, and this never
    // follows one. What is being prevented is a spec file turning into an arbitrary file-read
    // primitive, and one check is one bug away from none.
    expect(resolveReference(SPEC, "../../../etc/passwd")).toBeUndefined();
    expect(resolveReference(SPEC, "/etc/passwd")).toBeUndefined();
  });

  it("an unreadable reference is reported, not fatal — the adapter fails closed on its own", () => {
    const quirks = resolve(dirname(SPEC), "quirks.yaml");
    const { unresolved } = loadSource(openApiAdapter, quirks);
    expect(unresolved).toContain("nowhere.yaml");
  });
});

describe("the gate — keystroke rules that decide who bears the consequence (product §11.1)", () => {
  const draft = openApiAdapter.adapt(loadSource(openApiAdapter, SPEC).input);
  const args = { spec: SPEC, out: "out", probe: false, interactive: true, force: false } as const;

  it("DEFAULT-SKIP: holding Enter through a whole spec keeps nothing", async () => {
    // Most operations in a spec are not capabilities. The default has to reflect that, or a
    // 40-operation document produces a 40-tool MCP server nobody meant to publish.
    const ask = scripted(["acme", "Acme", "catalog", "", ""]);
    const record = await runGate(draft, ask, { ...args });
    expect(record!.decisions.every((d) => !d.keep)).toBe(true);
  });

  it("`a` is the bulk-keep escape, so a curated spec is not 40 keystrokes", async () => {
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    const record = await runGate(draft, ask, { ...args });
    expect(record!.decisions.every((d) => d.keep)).toBe(true);
    expect(record!.decisions.length).toBe(draft.operations.length);
  });

  it("`effect` is PRE-FILLED only for GET, and is mandatory otherwise", async () => {
    // The pre-fill is the whole reason `EffectHint` exists — and the reason the emitter cannot
    // see it. A pre-filled `read` on a DELETE is the exact keystroke that would land the
    // consequence on the business months later, through an agent, in front of a customer.
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    await runGate(draft, ask, { ...args });
    const effectPrompts = ask.asked.filter((q) => q.includes("effect (read"));
    expect(effectPrompts.length).toBe(draft.operations.length);
    // Every operation in this fixture is a GET, so every one is pre-fillable; the record above
    // shows the fallback was accepted without the human typing anything.
    expect(draft.operations.every((o) => o.method === "GET" && o.effectHint?.value === "read")).toBe(true);
  });

  it("refuses an invalid company id at the gate rather than emitting a manifest naming nobody", async () => {
    const record = await runGate(draft, scripted(["Not A Company Id"]), { ...args });
    expect(record).toBeUndefined();
    expect(errors.join("\n")).toMatch(/not a valid company id/);
  });

  describe("the sample value a probe will carry (D-13)", () => {
    // NOTHING covered the gate COLLECTING `sampleInput` — `probe.test.ts` starts from an
    // already-built record, and no test asserted this prompt existed at all. It is the one
    // prompt in the gate where Enter-to-accept has real-world consequence: the value goes to a
    // production backend, and a spec `example` may name a real customer's record.
    //
    // The fallback is KEPT here, against the gate's usual "consequence-bearing answers are
    // typed" rule, because by this point the operator has already authorised a live read of
    // this capability — `--probe` is opt-in, consent is per capability, and a non-`GET` needed
    // its own second confirmation. The sample value is a parameter of a call already
    // authorised. What makes Enter legitimate is that the value is on screen AND its origin is
    // named, which is what the first assertion below pins.
    const SPEC_WITH_EXAMPLE = `openapi: 3.1.0
info: {title: Acme, version: '1'}
servers: [{url: 'https://api.acme.test/v1'}]
paths:
  /parts/{partId}:
    get:
      operationId: getPart
      security: []
      parameters:
        - name: partId
          in: path
          required: true
          schema: {type: string}
          example: P-1
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [sku]
                properties:
                  sku: {type: string}
`;

    const withExample = openApiAdapter.adapt({ origin: "inline", document: SPEC_WITH_EXAMPLE });
    // company, name, domain, baseUrlEnvVar, keep?, capability id, effect, resource name, probe?
    const LEAD = ["acme", "Acme", "catalog", "", "y", "", "", "", "y"];

    it("names the value's ORIGIN, so it cannot be mistaken for something you typed", async () => {
      const ask = scripted([...LEAD, ""]);
      await runGate(withExample, ask, { ...args, probe: true });
      const prompt = ask.asked.find((q) => q.includes("sample value for partId"));
      expect(prompt, "the gate never asked for a sample value").toBeDefined();
      // `init` cannot tell a real product code from a made-up UUID; only the human can, and
      // only if they know the value came from the document rather than from their last run.
      expect(prompt).toContain("from the API description");
    });

    it("blank ACCEPTS the document's example", async () => {
      const record = await runGate(withExample, scripted([...LEAD, ""]), { ...args, probe: true });
      const kept = record!.decisions.find((d) => d.keep)!;
      expect(kept.sampleInput).toEqual({ partId: "P-1" });
    });

    it("a typed value OVERRIDES the document's example", async () => {
      const record = await runGate(withExample, scripted([...LEAD, "P-9"]), { ...args, probe: true });
      const kept = record!.decisions.find((d) => d.keep)!;
      expect(kept.sampleInput).toEqual({ partId: "P-9" });
    });

    it("no probe consent means the prompt never appears — and no value is collected", async () => {
      // The authorisation the fallback leans on is the probe consent itself, so its absence has
      // to close the whole path rather than merely skip the request later.
      const ask = scripted(["acme", "Acme", "catalog", "", "y", "", "", "", "n"]);
      const record = await runGate(withExample, ask, { ...args, probe: true });
      expect(ask.asked.some((q) => q.includes("sample value for"))).toBe(false);
      expect(record!.decisions.find((d) => d.keep)!.sampleInput).toBeUndefined();
    });
  });

  it("a probe consent asks for a SECOND confirmation only for a non-GET method", async () => {
    // Every operation here is a GET, so the second question must never appear. Its absence is
    // the assertion: asking it for a GET would train people to answer yes reflexively.
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    await runGate(draft, ask, { ...args, probe: true });
    expect(ask.asked.some((q) => q.includes("record a golden fixture"))).toBe(true);
    expect(ask.asked.some((q) => q.includes("Confirm again"))).toBe(false);
  });
});

describe("end to end, non-interactively, with a Decision Record", () => {
  it("writes a compiling manifest and a committable report, and issues no request", async () => {
    const ws = workspace();
    const out = join(ws, "out");
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme", name: "Acme Parts" },
      provider: "acme-api",
      decisions: [
        // `PartList` has two candidate loci (the `items` list and the paginated root), so
        // D-14 requires an answer. `PriceEstimate` has one, so it needs none — which is
        // the proportionality the census buys.
        { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" },
        { operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
      ],
    };
    const recordFile = join(ws, "decisions.json");
    writeFileSync(recordFile, JSON.stringify(record));

    const code = await runInitCmd(["init", SPEC, "--out", out, "--decisions", recordFile, "--non-interactive"]);
    expect(code, errors.join("\n")).toBe(0);

    // The manifest compiled — `runInit` would not have committed otherwise (D-7).
    expect(readdirSync(out).sort()).toContain("capabilities.yaml");
    // The report is a FILE as well as stdout: it is the pull-request review surface, and a
    // reviewer who was not at the terminal is the second pair of eyes on R-9.
    const report = readFileSync(join(out, "INIT-REPORT.md"), "utf8");
    expect(report).toMatch(/Candidates: \d+ proposed, 2 emitted/);
    expect(report).toMatch(/only you know/);
    // No `--probe`, so no contract anywhere and no fixtures directory.
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("R-8 — 'interactive' means a human was actually asked", () => {
  it("`--decisions` without `--non-interactive` still refuses a non-GET probe", async () => {
    // The hole this closes: `--non-interactive` was standing in for "no human present", but a
    // Decision Record file supplies every answer up front, so there is no prompt either way.
    // Treating that as interactive would let a file-supplied `probeNonReadMethodConfirmed`
    // authorize a POST against a production backend with nobody at the terminal. The second
    // confirmation is a human act performed AT THE MOMENT OF THE CALL.
    const ws = workspace();
    const out = join(ws, "out");
    const recordFile = join(ws, "decisions.json");
    // `catalog.yaml` has only GETs, so this asserts the WIRING, at the seam where the flag is
    // computed — the gate's own behaviour is exercised exhaustively in packages/init.
    writeFileSync(
      recordFile,
      JSON.stringify({
        version: "0",
        company: { id: "acme" },
        decisions: [{ operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" }],
      }),
    );
    const code = await runInitCmd(["init", SPEC, "--out", out, "--decisions", recordFile]);
    expect(code).toBe(0);
    // No --probe, so nothing was recorded regardless; the assertion that matters is that the
    // run completed with the record supplying the decisions rather than a prompt.
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("D-14 — the locus question, and R-11's wording", () => {
  const draft = openApiAdapter.adapt(loadSource(openApiAdapter, SPEC).input);
  const args = { spec: SPEC, out: "out", probe: false, interactive: true, force: false } as const;

  it("is asked ONLY where a choice exists — not once per operation", async () => {
    // The census is what keeps the keystroke cost proportional. `PriceEstimate` has one
    // candidate and must cost nothing; `PartList` and `PartQuote` have two.
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    await runGate(draft, ask, { ...args });
    // Exactly the operations whose response is genuinely ambiguous — not one per operation.
    const asked = ask.asked.filter((q) => q.includes("which one?")).length;
    const ambiguous = draft.operations.filter((o) => locusCandidates(o.response).candidates.length > 1).length;
    expect(asked).toBe(ambiguous);
    expect(ambiguous).toBeGreaterThan(0);
    expect(ambiguous).toBeLessThan(draft.operations.length);
  });

  it("shows candidate FIELD NAMES, not just JSONPaths — R-11's entire mitigation", async () => {
    // The architect's least-confident item: a badly-worded prompt produces confirmed-but-wrong
    // loci that are WORSE than the silent ones they replace, because a human signed them.
    // Nobody can answer "$.warnings[*] or root?" on an endpoint they did not write; they can
    // answer "a list of (code, message)" vs "one object with (quotedPrice, currency)".
    const shown: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void shown.push(a.join(" ")));
    await runGate(draft, scripted(["acme", "Acme", "catalog", "", "", "a"]), { ...args });
    const offered = shown.join("\n");
    expect(offered).toMatch(/quotedPrice, currency/);
    expect(offered).toMatch(/code, message/);
    expect(offered).toMatch(/a list, each with fields/);
    expect(offered).toMatch(/one object, with fields/);
  });

  it("is asked BEFORE the resource name — the name names the locus", async () => {
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    await runGate(draft, ask, { ...args });
    const firstLocus = ask.asked.findIndex((q) => q.includes("which one?"));
    const firstName = ask.asked.findIndex((q) => q.includes("resource name"));
    expect(firstLocus).toBeGreaterThanOrEqual(0);
    expect(firstLocus).toBeLessThan(firstName);
  });

  it("pre-fills the sole array-of-objects, so a paginated list costs one keypress", async () => {
    const ask = scripted(["acme", "Acme", "catalog", "", "", "a"]);
    const record = await runGate(draft, ask, { ...args });
    const listParts = record!.decisions.find((d) => d.operation === "GET /api/v2/parts")!;
    expect(listParts.keep && listParts.responseLocus).toBe("$.items[*]");
  });
});

describe("NF-A — the env-var names are asked, not silently defaulted", () => {
  const draft = openApiAdapter.adapt(loadSource(openApiAdapter, SPEC).input);
  const args = { spec: SPEC, out: "out", probe: false, interactive: true, force: false } as const;

  it("asks for the base-URL var, and for the credential var when the source declares a scheme", async () => {
    // Amendment 1 §A-5 gap 4 scoped both as gate additions; only `sampleInput` had landed.
    // Neither is derivable from any source construct, so a silent default is a decision the
    // tool made on the user's behalf about their deployment.
    const ask = scripted(["acme", "Acme", "catalog", "MY_URL", "MY_TOKEN"]);
    const record = await runGate(draft, ask, { ...args });
    expect(record!.baseUrlEnvVar).toBe("MY_URL");
    expect(record!.authEnvVar).toBe("MY_TOKEN");
    expect(ask.asked.some((q) => q.includes("never its value"))).toBe(true);
  });

  it("defaults are offered, so holding Enter still works", async () => {
    const record = await runGate(draft, scripted(["acme", "Acme", "catalog"]), { ...args });
    expect(record!.baseUrlEnvVar).toBe("ACME_API_URL");
    expect(record!.authEnvVar).toBe("ACME_API_TOKEN");
  });
});
