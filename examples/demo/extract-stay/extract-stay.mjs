// ADR-0011, runnable: a model extracts a tourism.Stay from a booking email, and Archstone
// judges the answer. No API key, no network, no model call — the four responses below are
// RECORDED, because this demo is about what the boundary does with an answer and a live model
// would print something different on every run.
//
// The manifest is the shipped tourism example, unmodified. The same `tourism.Stay` that
// `tourism.search` returns is, with no new declaration, the schema the model must produce.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import { fromIR } from "@archstone/agent";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = resolve(here, "../../manifests/tourism");

/** The unstructured input a real deployment would put in front of the model. */
const BOOKING_EMAIL = `
  Hi — confirming your stay at Casa Verde in Brașov, 3 nights from 14 May.
  Rate is 320 RON per night. Guests rate us 4.6 out of 5.
`.trim();

/**
 * What the model answered. Four runs, four things that can happen to one answer.
 * A real deployment gets these from its provider — see the README for where the schema goes in
 * each provider's request.
 */
const RECORDED = [
  {
    label: "every declared field, well-shaped",
    response: { name: "Casa Verde", location: "Brașov", pricePerNight: 320, rating: 4.6 },
  },
  {
    label: "the optional `rating` is absent",
    response: { name: "Casa Verde", location: "Brașov", pricePerNight: 320 },
  },
  {
    label: "the required `pricePerNight` is absent",
    response: { name: "Casa Verde", location: "Brașov", rating: 4.6 },
  },
  {
    label: "the model invented a `confidence` field nobody declared",
    response: { name: "Casa Verde", location: "Brașov", pricePerNight: 320, rating: 4.6, confidence: 0.91 },
  },
];

// A real embedder loads the artifact `archstone build` wrote; compiling the manifest here keeps
// the demo to one command. Round-tripped through JSON so fromIR sees exactly what ships.
const built = buildRegistry(manifest);
if (!built.registry) {
  console.error("could not compile the tourism manifest:", built.errors);
  process.exit(1);
}
const archstone = fromIR(JSON.parse(JSON.stringify(built.registry.ir)));

const stay = archstone.extractor("tourism.Stay", "anthropic");

console.log("The email the model was given:\n");
console.log(BOOKING_EMAIL.replace(/^/gm, "  "));

console.log("\nThe schema it was required to produce (closed — nothing else may appear):\n");
console.log(JSON.stringify(stay.schema, null, 2).replace(/^/gm, "  "));

console.log("\nThis goes in the provider request — Anthropic's `output_config.format`:\n");
console.log(JSON.stringify(stay.structuredOutput, null, 2).slice(0, 120).replace(/^/gm, "  ") + " …");

for (const { label, response } of RECORDED) {
  const result = stay.validate(response);
  console.log(`\n${"─".repeat(78)}\n${label}`);
  console.log(`  status:     ${result.status}`);
  if (result.missing) console.log(`  missing:    ${result.missing.join(", ")}`);
  if (result.invalid) console.log(`  invalid:    ${result.invalid.join(", ")}`);
  if (result.degraded) console.log(`  degraded:   ${result.degraded.join(", ")}`);
  if (result.undeclared) console.log(`  undeclared: ${result.undeclared.join(", ")}  ← dropped, never propagated`);
  console.log(`  data:       ${result.data ? JSON.stringify(result.data) : "(withheld)"}`);
}

console.log(`\n${"─".repeat(78)}`);
console.log("`ok` means the answer has the declared SHAPE. It does not mean the answer is true:");
console.log("a correctly-typed invention passes every check above.");
