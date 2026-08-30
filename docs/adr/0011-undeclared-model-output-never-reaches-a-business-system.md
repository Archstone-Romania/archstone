# ADR-0011: Undeclared Model Output Never Reaches a Business System

**Status:** ✅ Accepted (2026-08-29)
**Date:** 2026-08-29
**Deciders:** Adrian Bratulescu
**Related:** [ADR-0008](0008-undeclared-provider-data-never-reaches-a-model.md) · [ADR-0005](0005-open-core-boundary-artifact-guarantee.md) · [CDL Specification](../cdl-specification.md) · [RFC-0002](../rfc/0002-cdl-v0.2.md)

---

## Context

[ADR-0008](0008-undeclared-provider-data-never-reaches-a-model.md) governs one direction of
travel. A provider returns a body, `applyResponseMapping` builds a fresh object from the fields
the manifest **declares**, and everything else is dropped before a model sees it. Undeclared
provider data never reaches a model. That boundary is a stated guarantee, it holds for every
emitter because every emitter shares the mapper, and it has no flag.

The other direction has no boundary at all.

A model is not only a consumer of business data; it is increasingly a *producer* of it. An
assistant reads a clinical note, a supplier invoice, a claim form, an inbound email, and emits
structured fields that a business system then stores, indexes, bills against, or acts on. Today
Archstone has nothing to say about that half. A deployer using `@archstone/agent` hand-writes a
JSON Schema for the provider's structured-output parameter, hand-maintains it against a resource
they already declared in CDL, `JSON.parse`s the reply, and trusts it. Three failure modes follow,
none of them exotic:

1. **Two schemas for one entity.** `tourism.Stay` exists as a Resource Definition *and*, in the
   deployer's code, as a hand-written extraction schema. Nothing keeps them equal, and the one
   the compiler can check is not the one the model is given.
2. **Undeclared fields propagate.** A model that invents `confidence`, `notes`, or
   `patientAddress` hands them straight through `JSON.parse` into whatever the deployer does
   next. There is no mapping boundary on this path because there is no path — it is application
   code.
3. **A missing required field is discovered downstream.** Not at the boundary, where the
   equivalent provider-side failure produces a contract violation with the body withheld, but
   wherever the field is finally read.

The machinery to close this already exists and is already shared. `objectJsonSchema`
(`packages/emitter-support/src/lowering.ts`) lowers any IR field list — including a resource,
resolved recursively through the registry with a cycle guard — into typed, described JSON
Schema. It is exported. It is the one lowering every emitter uses. Run against the shipped
tourism resource it produces:

```json
{
  "type": "object",
  "properties": {
    "name":          { "description": "The property's display name.",      "type": "string" },
    "location":      { "description": "A place — city, region, or address.", "type": "string" },
    "pricePerNight": { "description": "Nightly rate for the stay.",        "type": "number" },
    "rating":        { "description": "Guest review score, when available.", "type": "number" }
  },
  "required": ["name", "location", "pricePerNight"]
}
```

Two things in that output are load-bearing for this decision, and both were measured rather than
assumed:

- **There is no `additionalProperties: false`.** Correct for an MCP `outputSchema`, where the
  document describes what a tool returns and a client validates against it. Wrong, silently, for
  a schema handed to a model as the shape of an extraction — a schema that permits anything extra
  is not a fail-closed schema, and shipping this one as if it were would make the guarantee a
  slogan.
- **The authored description of `location` is gone.** `fieldJsonSchema` spreads the semantic
  type's schema over the field's own, so wherever a semantic type carries a description the
  generic text wins and the manifest's is discarded. `location` is the only semantic type that
  ships one today, which is precisely why this reads as working code: it is correct on every
  other field. Tolerable while a description is documentation. Not tolerable once the description
  is the *instruction the model extracts against* — which is what it becomes here.

So the question this record answers is not whether to validate model output. It is whether
validating it means **inventing a second schema language** or **pointing the one we have in the
other direction**.

## Decision

**Undeclared model output never reaches a business system.** A CDL Resource Definition is the
schema for both directions of travel: the shape a capability's output is mapped into, and the
shape a model is required to produce. Extraction output is validated against the declared
resource at a boundary Archstone owns, undeclared keys are dropped there, and a missing required
field is a violation — the same three-state outcome (`ok` / `degraded` / `violation`) that
`applyResponseMapping` already returns, for the same reasons.

Four commitments follow.

**No new grammar.** CDL gains nothing. Resource Definitions are already manifests (§5.3 of the
specification), already loaded as named types, already in the IR. This decision adds no
primitive, so it does not touch a frozen 1.0 grammar and does not need the addition gate. That
property is not incidental — it is the argument. A capability language that needs a second,
parallel schema language to describe the same entity was not a capability language.

**The strict lowering is a distinct lowering, not a changed one.** Extraction requires
`additionalProperties: false` and requires the authored description to survive. Both differ from
what an MCP `outputSchema` should say, and the existing lowering is a published wire shape
reached by every shipped manifest. It is therefore extended by a sibling entry point over the
same field walker — never re-implemented, never edited in place. The rule that lowering lives in
exactly one package is upheld by sharing the recursion, not by overloading one output.

**Validation is structural, over the IR — not a second pass over the emitted schema.** The
validator reads `IRField` directly. It does not compile the lowered JSON Schema and hand it to a
validator library. Two representations of one contract drift, and the one that would win is the
derived one; validating the source keeps the emitted schema an *artifact* of the contract rather
than a second copy of it. It also keeps `emitter-support` what it is — no filesystem, no MCP SDK,
no runtime dependency added to the package every emitter builds on.

**Errors name the path and the expected type. Never the value.** Extraction input is, by
construction, the most sensitive text in the deployment: the clinical note, the invoice, the
claim. A validation message that echoes the offending value writes that text into whatever
catches the error. Reporting `patient.mrn: expected string` and never the byte that failed is the
same discipline that keeps `status.output` unpopulated in an `Execution` record, applied at the
one other boundary where model-adjacent data crosses into a log.

### Why "reject the whole extraction" was not chosen for undeclared keys

An undeclared key from a model is dropped and **named** in the result, not treated as fatal.

This is deliberately asymmetric with the *reason* ADR-0008 drops undeclared provider fields, and
the asymmetry is the point. A provider is a system: an unmapped field it returns is a fact about
someone's API, and dropping it silently is safe because a fingerprint diff and `adopt` exist to
surface it deliberately. A model is a generator: an extra key is a fact about *this inference* —
it may be drift, a prompt regression, or a schema the deployer forgot to update. Failing the
whole extraction on it makes the feature unusable against real models, which pad output as a
matter of course. Dropping it silently would discard the single most useful signal on this path.
So it is dropped **and reported**, and the deployer decides whether their own threshold is "log
it" or "refuse it".

What is *not* negotiable is that it does not propagate. There is no passthrough option here for
the same reason there is none in ADR-0008: a guarantee with a flag that disables it is a default.

### Why the alternatives were rejected

**A new CDL primitive for extraction schemas.** The obvious shape — an `extraction:` block, or a
resource variant marked as model-facing — was rejected before it was designed. Resources already
say what the entity is. A second way to say the same thing splits the vocabulary permanently,
requires the language-addition gate to be satisfied for a capability the language already has,
and would leave the compiler unable to guarantee that the two descriptions of `tourism.Stay`
agree.

**Compile the emitted JSON Schema and validate with a schema library.** Rejected on three counts.
It adds a runtime dependency to the one package deliberately kept free of them. It validates
against the derived artifact rather than the contract, so the emitted schema silently becomes the
source of truth. And the three-state result this boundary needs — a missing *optional* field
degrades, a missing *required* field violates — is not what a schema validator returns; it would
have to be reconstructed from error objects, which is the same logic written twice in a less
testable place.

**Repairing invalid output — re-prompting, coercing `"42"` to `42`, filling defaults.** Rejected.
Every one of them converts a governance boundary into a heuristic, and all of them share one
consequence: a repaired extraction is indistinguishable downstream from a correct one. The
deployer who needs a retry loop can write one around a `violation` result, where their own policy
is visible in their own code. Archstone's boundary reports; it does not launder.

**Putting the validator in `@archstone/schema`.** That package already owns Ajv and already
validates a machine-emitted record (`validateExecution`), which makes it the tempting home. It is
the authoring loader: it reads schema files from disk and exists to check documents a human
wrote. An extraction result is neither authored nor on disk, and reaching it through a
filesystem-bound package would put `node:fs` in the dependency path of every embedded agent — the
precise coupling `@archstone/agent`'s boundary test exists to prevent.

## Consequences

**Accepted:**

- The strict lowering's output is a published shape once shipped, on the same terms as any
  emitted schema: additive changes only, and a resource that compiles today produces a schema a
  model can satisfy tomorrow.
- **Description quality becomes a correctness concern, not documentation.** Once a field's
  description is what a model extracts against, the semantic type overwriting it is a defect
  rather than a cosmetic loss, and fixing it changes emitted output for existing manifests. That
  is a real, if small, behaviour change to accept knowingly rather than discover.
- Two entry points now exist where one did. The cost is a permanent obligation to keep them
  walking the same fields, discharged by construction (one walker) and by test, not by care.
- We take on the honesty burden that comes with the word "validation". See R-3.

**Rejected:**

- Emitting extraction results into the `Execution` audit record. An extraction is not a
  capability invocation: no provider is called, no `effect` applies, no policy is evaluated.
  Widening `Execution` to cover it would make the record's own definition — one invocation
  attempt against one bound capability — false, to gain a log line the deployer can write from
  the returned result.
- Deriving a "confidence" or "quality" score from validation. Structural conformance is not
  correctness, and a number that conflates them would be believed.

**Risks:**

- **R-1 — The schema and the validator disagree.** If the strict lowering accepts a document the
  structural validator rejects (or the reverse), the model is being told one contract and judged
  against another, and the failure is invisible until a deployer reports an extraction that
  "should have worked". Mitigation: one shared field walker, and a conformance test asserting the
  two agree over every semantic type and both composite field forms. *(M/H)*
- **R-2 — `additionalProperties: false` does not survive every provider envelope.** The Gemini
  function-calling `Schema` object is a subset of JSON Schema and already requires
  `sanitizeGeminiSchema` to strip what it does not accept. Where the constraint is stripped, the
  model is not *told* the object is closed even though the validator still closes it — a quality
  difference, not a safety one, but one a deployer must be able to read rather than infer. *(M/L)*
- **R-3 — "Validated" is heard as "correct".** A fluent, well-typed hallucination passes every
  check this decision introduces: the boundary proves shape, never truth. A regulated reader who
  sees the word "validation" will assume more. This statement belongs on the type and in the
  guide, for the same reason the audit sink carries its own lossiness warning where a deployer
  wires it. *(H/H)*

**Out of scope, so it is not searched for later:**

Field-level sensitivity annotations (`phi`, `pii`) and the policies that would attach to them —
a separate decision requiring a grammar addition, deliberately not smuggled in here. Streaming
and partial extraction: CDL is a synchronous request/response language (§2) and this boundary
inherits that. Re-prompt and retry orchestration. Any mapping of extraction output onto a
capability *input* — plausible, unasked for, and it would put a model in the loop of an
`irreversible` effect without a decision saying so.
