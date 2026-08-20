# ADR-0001 — The open-core boundary

**Status:** proposed
**Date:** 2026-08-20
**Deciders:** Archstone core

---

## Context

Archstone is Apache-2.0 and has been since the first commit. At v0.11.5 it is published on
npm, listed in the MCP Registry, and running one real production deployment
([ArtVinci](../../CASE-STUDY.md)). It has no commercial surface at all: no paid tier, no
hosted product, no pricing, no lead capture beyond an email address.

That is the right state for a compiler nobody has adopted yet, and the wrong state to stay in.
The question this ADR answers is not *how do we bill* — it is **which line will we never
cross**, because every subsequent commercial decision either respects that line or quietly
erodes it.

The failure mode we are avoiding is the common one: ship free, gain adoption, then move a
capability people already depend on behind a paywall. That is a one-time revenue event bought
with permanent credibility. A compiler in particular cannot survive it — the whole argument for
writing your business in CDL is that the description outlives the vendor. A description you
cannot compile without paying us is not that.

## Decision

**The free core is defined by the artifact, not by the feature list.** Everything required to
take a CDL manifest and turn it into something an agent can call — forever, offline, with no
account — is Apache-2.0 and stays that way:

| Free forever, Apache-2.0 | Package |
|---|---|
| CDL — the language and its JSON Schema | `packages/schema` |
| The compiler, and the IR it lowers to | `packages/compiler` |
| IR indexing, lowering, mapping, policy, rate-limit, audit primitives | `packages/emitter-support` |
| The MCP emitter (stdio + HTTP), and every future emitter | `packages/runtime` |
| The embedded SDK — `fromIR`, `tools`, `execute` | `packages/agent` |
| `archstone init` / `apply` / `build` / `serve` / `verify` | `packages/cli` |
| REST provider adapter, and future provider adapters | `providers/*` |

Concretely: **`archstone build` and `archstone serve` must never require a network call, an
account, or a key.** A business that vendored a manifest and pinned a CLI version must be able
to keep compiling and serving it indefinitely with no relationship to us. `verify` must remain
runnable locally against your own backend, and its `--json` output must stay complete — we do
not degrade the free output to make a hosted product look better.

**What is commercial is the operation of those artifacts over time, on our machines:**

- **Continuous drift detection** — `verify` run on a schedule against your live backends,
  with history and alerting when a binding goes 🔴. The local one-shot stays free; the
  *watching* is the product.
- **Audit and spend observability** — hosted collection of `ExecutionRecord` streams
  (`packages/emitter-support/src/audit.ts`), retained and queryable across capabilities and
  time. The sink interface and the local JSON-lines sink stay free.
- **Managed endpoints** — hosting the bridge for teams that do not want to run a node, as
  already offered on the site. Pure utility, no ranking or placement: we host the technical
  bridge, the business keeps control of where it leads.
- **Design-partner engagements** — paid onboarding: we write the first manifest with you,
  wire `build` + `verify` into your CI, and ship it to production.

**No feature that is free today becomes paid.** If a capability currently ships in an
Apache-2.0 package, its being useful to a paying customer is not grounds for moving it. New
commercial value is added alongside, or it is not added.

## Sequencing

1. This ADR, and a short statement of it in the README, **before** anything is sold — the
   commitment is worth less if it arrives as a reassurance after the invoice.
2. A commercial section on the site with a design-partner offer and real lead capture. Today
   the site ends at `hello@archstone.dev`; there is no conversion surface and therefore no
   funnel data.
3. Paid design partners (target 3–5, ArtVinci-shaped). This validates willingness to pay in
   weeks, and each one is the second and third case study, which is the site's actual
   bottleneck.
4. Productize drift monitoring — the first recurring SKU — once partners have said out loud
   that it is what they would pay for.

Billing infrastructure appears at step 4, not before. Nothing in steps 1–3 needs Stripe,
license keys, or a tier matrix.

## Consequences

**Accepted:**
- The free core is genuinely enough to run a business on. ArtVinci runs entirely inside it and
  would owe us nothing. We are choosing adoption over early extraction, and the revenue has to
  come from operating things, which is harder than gating things.
- A competitor can fork the compiler. That is the deal Apache-2.0 already made; this ADR only
  makes us honest about it. The defensibility is the IR and the accumulated correctness (see
  the dogfooding section of the case study), not withheld source.
- Commercial features run on infrastructure we must actually operate, with the on-call cost
  that implies.

**Rejected alternatives:**
- *Gate `verify` or the audit hooks.* They are the most differentiated things in the repo,
  which is exactly why gating them would cost the most adoption. We sell them as a service, not
  as a license.
- *Relicense to BSL/SSPL.* Solves a problem we do not have (nobody is reselling Archstone) at
  the cost of the one we do (nobody is using it).
- *Usage-based pricing on compiled calls.* Metering execution would require the compiled
  artifact to phone home, which contradicts the decision above.

## Non-goals

This ADR does not set prices, define tiers, or commit to a hosted architecture. It fixes the
boundary those decisions must respect.
