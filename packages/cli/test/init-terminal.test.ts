import { describe, it, expect } from "vitest";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { openApiAdapter } from "@archstone/init";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promptFailureKind, runGateOverTerminal, terminalAsk, type InitArgs } from "../src/init";

// THE TERMINAL BOUNDARY — the one thing `init.test.ts` cannot test, by construction.
//
// Every other gate test drives a fake `Ask` that honours the fallback. That fake implements the
// INTERFACE, and the interface is not where the bugs were: `runGate` passes its fallbacks
// correctly and they were dropped on the far side. A substitute for a boundary is blind to a bug
// in the boundary, so the only instrument that works is a REAL `readline.Interface`.
//
// Both defects this file pins were found by filming a launch GIF — i.e. by the first person ever
// to run the interactive gate against a terminal. Everything in the gate had been exercised only
// against the double.
//
// These run over `PassThrough` pipes rather than a pty, and that is sufficient for the defect
// that mattered: readline ignores a second string argument over a pipe exactly as it does over a
// TTY (asserted below, first test). Only Ctrl+D's KEYSTROKE needs a pty; the error it raises is
// an ordinary readline `AbortError`, which the signal path produces identically.

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../init/test/fixtures/openapi/catalog.yaml");

/** A real `readline.Interface` over pipes, plus everything written to its output. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (c) => written.push(String(c)));
  const rl = createInterface({ input, output });
  return { rl, input, written, prompts: () => written.join("") };
}

const ARGS: InitArgs = {
  spec: SPEC,
  out: "out",
  probe: false,
  interactive: true,
  force: false,
};

describe("readline's own contract — why `terminalAsk` has to exist", () => {
  it("CHARACTERIZATION: `rl.question(query, fallback)` silently ignores the fallback", () => {
    // `readline/promises` is `question(query[, options])`, where `options` is `{signal}`. A
    // `readline.Interface` nonetheless satisfies `Ask` STRUCTURALLY — `question(text, anything?)`
    // is assignable — so passing the interface itself type-checks and drops every default.
    // That is what shipped, and this test is the fact that made it possible.
    const { rl, input } = terminal();
    const pending = rl.question("Company id ", "THE-FALLBACK" as never);
    input.write("\n");
    return pending.then((answer) => {
      expect(answer, "if this ever returns the fallback, readline changed and `terminalAsk` can be reconsidered").toBe("");
      rl.close();
    });
  });
});

describe("`terminalAsk` against a real readline (G-1)", () => {
  it("an empty line takes the default", async () => {
    const { rl, input } = terminal();
    const pending = terminalAsk(rl).question("Company id ", "wanderlust");
    input.write("\n");
    expect(await pending).toBe("wanderlust");
    rl.close();
  });

  it("SHOWS the default in the prompt, the way `confirm` shows [Y/n]", async () => {
    // A default the user cannot see is not a default, it is a coincidence. The shipped gate
    // computed a `${COMPANY}_API_URL` suggestion and rendered a bare prompt.
    const { rl, input, prompts } = terminal();
    const pending = terminalAsk(rl).question("Env var holding the backend base URL ", "WANDERLUST_API_URL");
    input.write("\n");
    await pending;
    expect(prompts()).toContain("[WANDERLUST_API_URL]");
    rl.close();
  });

  it("a typed answer beats the default", async () => {
    const { rl, input } = terminal();
    const pending = terminalAsk(rl).question("Company id ", "wanderlust");
    input.write("acme\n");
    expect(await pending).toBe("acme");
    rl.close();
  });

  it("with no default, the prompt is unchanged and an empty line stays empty", async () => {
    // The locus and resource-name prompts deliberately have no pre-fill; a bracket there would
    // advertise a default that does not exist.
    const { rl, input, prompts } = terminal();
    const pending = terminalAsk(rl).question("resource name (blank = derive from the source) ");
    input.write("\n");
    expect(await pending).toBe("");
    expect(prompts()).not.toContain("[");
    rl.close();
  });
});

describe("the gate's flags actually reach the terminal (G-1, end to end)", () => {
  it("`--company` and `--domain` answer their prompts when the user just presses Enter", async () => {
    // THE REGRESSION. Before the fix this run died at the first prompt with
    // "'' is not a valid company id", because `--company` never reached the answer.
    const draft = openApiAdapter.adapt({ origin: "catalog.yaml", document: readFileSync(SPEC, "utf8") });
    const { rl, input } = terminal();

    const pending = runGateOverTerminal(draft, rl, { ...ARGS, company: "wanderlust", domain: "tourism" });
    // Enter for every prompt the gate asks. Default-skip means every candidate is declined, so
    // the run ends with an empty confirmed set — which is fine: what is under test is that the
    // three answered-by-flag prompts accepted their defaults instead of failing validation.
    const holdEnter = setInterval(() => input.write("\n"), 1);
    const outcome = await pending;
    clearInterval(holdEnter);
    rl.close();

    expect(outcome, "the gate refused — a default was dropped again").not.toBeUndefined();
    expect(typeof outcome).not.toBe("string");
    const record = outcome as Exclude<typeof outcome, string | undefined>;
    expect(record.company.id).toBe("wanderlust");
    expect(record.baseUrlEnvVar).toBe("WANDERLUST_API_URL");
  });
});

describe("cancellation is a clean refusal, not a stack trace (G-2)", () => {
  it("recognizes a REAL readline AbortError", async () => {
    // Produced by readline itself, not hand-rolled. Ctrl+D at a TTY raises the same class from
    // `_ttyWrite` (`AbortError: Aborted with Ctrl+D`); the keystroke needs a pty, the error does
    // not. Matched on `name`/`code` because the class Node throws is internal.
    const { rl } = terminal();
    const controller = new AbortController();
    const pending = rl.question("Company id ", { signal: controller.signal });
    controller.abort();

    const error = await pending.then(() => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(promptFailureKind(error)).toBe("no-more-input");
    rl.close();
  });

  it("does not mistake an ordinary failure for a cancellation", () => {
    // Swallowing a real bug as "the user changed their mind" would be a worse silence than the
    // stack trace this replaces.
    expect(promptFailureKind(new Error("connection reset"))).toBeUndefined();
    expect(promptFailureKind(new TypeError("x is not a function"))).toBeUndefined();
    expect(promptFailureKind("AbortError")).toBeUndefined();
    expect(promptFailureKind(undefined)).toBeUndefined();
  });

  it("`runGateOverTerminal` turns cancellation into a value and lets real errors through", async () => {
    const draft = openApiAdapter.adapt({ origin: "catalog.yaml", document: readFileSync(SPEC, "utf8") });

    const abort = Object.assign(new Error("Aborted with Ctrl+D"), { name: "AbortError", code: "ABORT_ERR" });
    const cancelled = await runGateOverTerminal(draft, { question: () => Promise.reject(abort) }, { ...ARGS });
    expect(cancelled).toBe("no-more-input");

    const boom = new Error("stdin exploded");
    await expect(runGateOverTerminal(draft, { question: () => Promise.reject(boom) }, { ...ARGS })).rejects.toThrow("stdin exploded");
  });
});

describe("a terminal that goes away is also a clean refusal (G-3)", () => {
  // FOUND WHILE FIXING G-2, and in the same class: the fake `Ask` never closes, so nothing about
  // a dying stdin was ever exercised. It also corrected a comment — the bound on prompt attempts
  // justified itself with "readline resolves with '' forever at EOF", which is not what
  // `readline/promises` does on this Node.
  it("CHARACTERIZATION: asking after EOF throws ERR_USE_AFTER_CLOSE, it does not resolve ''", async () => {
    const { rl, input } = terminal();
    input.end();
    await new Promise((r) => setImmediate(r));
    const error = await rl.question("q ").then(() => undefined).catch((e: unknown) => e);
    expect((error as { code?: string })?.code).toBe("ERR_USE_AFTER_CLOSE");
    expect(promptFailureKind(error)).toBe("terminal-closed");
  });

  it("a question PENDING when stdin closes refuses loudly instead of exiting 0 in silence", async () => {
    // THE WORST OUTCOME THIS REPLACES, and it is not a hang. Readline neither resolves nor
    // rejects a pending question at EOF; with no handle left to wait on, Node drains the event
    // loop and the process exits 0 — having asked a question nobody answered and written
    // nothing. A script that pipes answers in reports SUCCESS.
    //
    // Verified against the real CLI: `printf '…' | archstone init` exited 0 with no files and no
    // message. Piping answers has never worked and cannot be made to work here — `question`
    // registers a one-shot line handler and readline has no queue, so a pipe's lines all arrive
    // at once, answer 1 is consumed and the rest are discarded. `--decisions` is the supported
    // way to answer without a human; this makes the unsupported way fail loudly.
    const { rl, input } = terminal();
    const pending = terminalAsk(rl).question("Company id ", "wanderlust");
    input.end();

    // The boundary translates into a PRIVATE sentinel rather than letting the raw `AbortError`
    // escape, so that an abort raised anywhere else inside `runGate` — a future fetch with a
    // timeout, say — cannot be relabelled as "the user stopped answering". Asserted by name and
    // kind, since keeping the class unexported is the point.
    const outcome = await Promise.race([
      pending.then(() => "resolved").catch((e: unknown) => `${(e as Error).name}:${(e as { kind?: string }).kind}`),
      new Promise((r) => setTimeout(() => r("SILENT"), 1000)),
    ]);
    expect(outcome, "the gate went quiet on a prompt nobody can answer").toBe("PromptUnavailable:no-more-input");
  });

  it("an AbortError from anywhere OTHER than the prompt is NOT relabelled", async () => {
    // THE HAZARD THE NARROWING EXISTS FOR. `runGateOverTerminal` used to classify whatever
    // escaped the whole of `runGate`, so a later change adding a fetch with an
    // `AbortController` inside it would have had its timeout reported to the user as "you
    // stopped answering", and the run would exit 2 looking like a clean refusal. Simulated by
    // an `Ask` that answers prompts normally and then aborts the way an unrelated component
    // would.
    // Injected through `once`, which runs inside `runGateOverTerminal`'s `try` but OUTSIDE the
    // prompt — the shape of the hazard without needing a real fetch in the gate. An abort that
    // did not come from asking a question must stay an error.
    const draft = openApiAdapter.adapt({ origin: "catalog.yaml", document: readFileSync(SPEC, "utf8") });
    const rl = {
      question: async (): Promise<string> => "acme",
      once: (): never => {
        throw Object.assign(new Error("upstream fetch timed out"), { name: "AbortError", code: "ABORT_ERR" });
      },
    };
    await expect(runGateOverTerminal(draft, rl, { ...ARGS })).rejects.toThrow("upstream fetch timed out");
  });

  it("`runGateOverTerminal` reports a closed terminal distinctly from a cancellation", async () => {
    // Same disposition, different sentence: a CI runner whose stdin closed did not change its
    // mind, and telling it that it did is a small lie that costs someone an hour.
    const draft = openApiAdapter.adapt({ origin: "catalog.yaml", document: readFileSync(SPEC, "utf8") });
    const closed = Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
    expect(await runGateOverTerminal(draft, { question: () => Promise.reject(closed) }, { ...ARGS })).toBe("terminal-closed");
  });
});
