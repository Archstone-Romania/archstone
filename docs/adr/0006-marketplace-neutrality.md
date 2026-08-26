# ADR-0006: Selection Is Never for Sale

**Status:** ✅ Accepted (2026-08-23)
**Date:** 2026-08-21 · ratified 2026-08-23
**Deciders:** Adrian Bratulescu
**Related:** [ADR-0005](0005-open-core-boundary-artifact-guarantee.md)

> **Public edition.** Reproduced from the ratified decision record. The decision, its reasoning,
> its rejected alternatives and its consequences are unabridged; references to internal planning
> documents have been removed or summarised in place. The commitments stated here are the ones
> in force.

---

## Context

Anything that helps an agent choose between providers has to rank them. A subscriber asks for a
frame for a 40×50 canvas, forty framing shops can serve it, and the assistant receives one or
three — so something ordered them. Whatever does the ordering is the most valuable real estate
such a product will ever have, and the standard way to monetize it is to sell it.

We have already said publicly that we do not. The hosting section of archstone.dev promises *"no
bidding wars that rank one business above another,"* written when hosting was the only thing on
offer; the same instinct governs packaging, where [ADR-0005](0005-open-core-boundary-artifact-guarantee.md)
fixes what stays free.

The problem is where that promise currently lives: in marketing copy and in planning documents
that expect revision. Both can be edited by whoever needs the quarter to work. This is the
identical gap ADR-0005 closed for the open-core boundary, and it wants the identical fix — before
there is money on the other side of it rather than after.

## Decision

**Position in Archstone's selection results is not purchasable, in any form.** No paid placement,
no sponsored results, no ranking boost bundled into a tier, and no revenue share that varies with
which provider gets chosen — a percentage of the sale is a standing incentive to rank the seller
who yields more, so it is excluded here as well.

**Selection is deterministic and explainable.** A provider appears because it declared a
capability that matches the request, and it is ordered by evidence the customer could check —
verified binding health, lifecycle state — never by commercial relationship. Whatever the rule
is, it must be statable in one paragraph a provider can read.

**Reversal requires a superseding ADR and a public change first.** If this is ever revisited, the
sequence is: supersede this ADR, change the public statement, then take money — in that order.
Never a product change that quietly makes an existing promise false.

## Consequences

**Accepted:**

- Paid placement is the mechanism that makes marketplaces profitable, and this forgoes it
  permanently. Distribution stays monetizable only on the provider side — by what a provider
  uses, never by where a provider ranks — and this ADR caps the ceiling of that business on
  purpose.
- Ranking becomes an engineering obligation rather than a lever: if it must be explainable, it
  must be *specified*. This ADR makes that specification non-optional rather than an open
  question to be settled later by whatever the code happened to do.
- Any future change of control inherits this. That is the intended effect of a ratchet.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Paid placement, disclosed | Disclosure fixes the ethics of the label, not the incentive underneath it. A provider deciding whether to expose its catalog through us is asking whether we will later charge for visibility it already had; "we disclose it" is a yes. |
| Neutral now, revisit at scale | An expiring promise buys none of the trust a permanent one does, and the revisit lands exactly when the incentive to break it peaks. If we would not hold it at scale, we should not claim it now. |
| Leave it in a product document | A product document expects revision, and says so of itself. The commitment has to sit where a packaging revision cannot reach it. |

## Ratification note (2026-08-23)

Accepted as written. The narrower alternative — ban paid *placement* but leave a transaction
revenue share open — was considered and declined, because a percentage of the sale is a standing
incentive to rank the seller who yields more: the same defect wearing an accounting label.

What ratification obliges, and it is not free: the ordering rule must now be **specified**, not
left to the implementation. Top-1 versus top-N, and how ties break, move from open question to
prerequisite — "deterministic and explainable" is a claim we have to be able to demonstrate, and
an unspecified rule decided by accident inside the code cannot be demonstrated to anyone.

## Non-goals

This does not specify the ranking rule, decide what providers pay, or authorise building any
particular selection surface. It fixes one thing: that whatever rule is written, it is not for
sale.
