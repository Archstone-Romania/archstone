# ADR-0005: The Open-Core Boundary Is an Artifact Guarantee, Not a Feature List

**Status:** ✅ Accepted (2026-08-23)
**Date:** 2026-08-21 · ratified 2026-08-23
**Deciders:** Adrian Bratulescu
**Related:** [ADR-0006](0006-marketplace-neutrality.md) · [README — What is free, and what we sell](../../README.md)

> **Public edition.** Reproduced from the ratified decision record. The decision, its reasoning,
> its rejected alternatives and its consequences are unabridged; references to internal planning
> documents have been removed or summarised in place. The commitments stated here are the ones
> in force.

---

## Context

Archstone's packaging is drawn feature by feature elsewhere, on a stated rule: the governance
mechanism ships free, and operating that mechanism at scale on our machines is what is paid.
That line is the right one, and this ADR does not reopen it.

What a feature list cannot do is survive its own future. It says what is free **in the row as
written today**, and every later packaging revision is free to move a row. The commitment a
business needs before it writes its CDL is not "policy evaluation is free in the August 2026
table" — it is *the thing I built will keep working, on my machine, without you.* A promise that
lives only inside a revisable table is not a promise.

This is decided now rather than later for a specific reason. Otherwise the first public statement
about what is free gets made under commercial pressure, one enquiry at a time, by whoever happens
to be answering. Deciding the durable part in advance is what keeps those answers consistent with
each other.

The failure mode being avoided is the ordinary one: ship free, gain adoption, then move a
capability people already depend on behind a paywall. For a compiler this is fatal rather than
merely unpopular. The entire argument for describing your business in CDL is that the description
outlives the vendor — your capabilities are the source of truth, not our runtime. A description
you cannot compile without paying us is not that, and [ArtVinci](../../CASE-STUDY.md) — whose
manifest lives in ArtVinci's own repository — is the existing proof we would be breaking.

## Decision

**The free core is defined by the artifact, not by the feature list.** Two commitments, both
durable across future packaging revisions:

**1. The compile-and-run path never requires us.** `archstone build` and `archstone serve` must
never require a network call, an account, or a key. A business that vendored a manifest and
pinned a CLI version can keep compiling and serving it indefinitely with no relationship to
Archstone. `archstone verify` stays runnable locally against the customer's own backend, and its
`--json` output stays complete — we do not degrade free output to make a hosted product look
better. This covers everything in this repository by construction: CDL and its schema, the
compiler and the IR, `emitter-support`, every emitter, the embedded SDK, the CLI, and the
provider adapters.

**2. No feature that is free today becomes paid.** If a capability ships in an Apache-2.0
package, its being useful to a paying customer is not grounds for moving it. New commercial value
is added alongside the open core, or it is not added. The packaging table may be revised in
either direction for *new* rows and for what the paid tiers include; it may not relocate an
existing free mechanism into a paid tier.

This is a ratchet under the packaging decision, not a replacement for it. Packaging answers *what
is in which tier*; this ADR answers *which of those answers a customer may rely on after we
revise the table*.

## Consequences

**Accepted:**

- The free core is genuinely enough to run a business on, and ArtVinci is the proof: it runs
  entirely inside the open core and owes us nothing. Revenue has to come from operating things,
  which is harder than gating things.
- Commitment 1 constrains engineering permanently: no telemetry, licence check, or registry
  lookup may enter the `build`/`serve` path, however convenient. This is the same one-way
  dependency rule already enforced mechanically on imports, extended to runtime behaviour, and it
  should be enforced the same way — mechanically, not by review memory.
- A competitor can fork the compiler. Apache-2.0 already made that deal; this ADR only makes us
  honest about it. Defensibility is the IR and accumulated correctness, not withheld source.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Gate `verify` or the audit hooks | They are the most differentiated things in the repository, which is exactly why gating them costs the most adoption. Paywalling "who invoked what" hands anyone weighing a hand-written MCP server a real argument. We sell operating them, not the right to run them. |
| Relicense to BSL or SSPL | Solves a problem we do not have — nobody is reselling Archstone — at the cost of the one we do: being adopted at all. |
| Meter execution of self-run compiled artifacts | Would require the compiled artifact to phone home, contradicting commitment 1. The rejection is specifically of metering a customer's own `serve` or embedded execution; metering calls that traverse a hosted runtime we operate is a separate question this ADR does not touch. |

## Non-goals

This ADR sets no prices, defines no tiers, and ratifies no hosted architecture. It fixes the
boundary those decisions must respect.

## Ratification note (2026-08-23)

Accepted as written, both commitments unnarrowed. Two facts the ratification was made against,
recorded so the decision is not re-read later as more casual than it was:

- **The promise was already public.** Commitment 1 has shipped in the README served by GitHub and
  by npm since v0.11.6. Ratifying aligned the internal record with what users already read; it
  did not create the exposure.
- **The free surface grew before ratification.** v0.12.0 added a distributed rate-limit counter,
  file-backed audit retention and `archstone audit`. Under commitment 2 all three are now
  permanently free — and all three were plausible candidates for a paid tier. The boundary
  applied: we sell *operating* them, not the right to run them. `verify` run once locally is
  free; `verify` watched on a schedule, with history and alerting, is the product. That test was
  accepted along with the ADR.

## Follow-ups

- State commitment 1 in the public `README.md` — done in the same increment. The commitment is
  worth less if it first appears as reassurance after an invoice.
- A mechanical check that no network or authentication call can enter the `build`/`serve` path,
  alongside the existing import-boundary check.
