# ADR-0008: Undeclared Provider Data Never Reaches a Model

**Status:** ✅ Accepted (2026-08-24)
**Date:** 2026-08-24
**Deciders:** Adrian Bratulescu
**Related:** [ADR-0005](0005-open-core-boundary-artifact-guarantee.md) · [CDL Specification](../cdl-specification.md)

> **Public edition.** Reproduced from the ratified decision record. The decision, its reasoning,
> its rejected alternatives and its consequences are unabridged; references to internal
> architecture and planning documents have been removed or summarised in place. The guarantee
> stated here is the one in force.

---

## Context

`applyResponseMapping` iterates a binding's **declared** mapping fields and builds a fresh object
from them. Every key the provider returns that the manifest does not name is dropped before the
model sees anything. This had been true since response mapping was introduced and was never
written down as a decision — it fell out of the implementation, which is exactly the kind of
load-bearing accident that a rule requiring an ADR for every structural decision exists to catch.

It became a decision the moment someone asked for the opposite. The request was reasonable on its
face: *when the provider's API grows a field after `init` ran, the assistant should use it rather
than discard it.* A self-improving integration is a better story than a stale one, and the person
asking was not wrong that today's behaviour has a cost.

Measured on the tourism example, with a mock returning three fields the manifest does not name:

| | |
|---|---|
| Backend returned | `name`, `location`, `pricePerNight`, `rating`, `boardType`, `cancellationPolicy`, `distanceToBeachM` |
| Model received | `name`, `location`, `pricePerNight`, `rating` |
| `verify` reported | `🟡 response shape changed (fingerprint sha256:cabe20… → sha256:37fc66…) but mapping still resolves` |

Two real gaps, and they are the honest half of the request:

1. **The alarm carries no information.** An operator seeing amber cannot diff by hand, because
   nothing records the response *shape* — the `contract:` block stores a hash, and a hash does not
   subtract. The signal says "something moved" and stops.
2. **The manifest silently under-uses the backend.** A field the provider added on Tuesday stays
   invisible until a human edits the manifest, and nothing tells them what to add.

So the question is not whether to act on additive drift. It is whether acting on it means
*forwarding* it or *naming* it.

## Decision

**Undeclared provider data never reaches a model.** Unmapped fields stay dropped at the mapping
boundary. There is no flag, no per-binding escape hatch, and no "trusted provider" mode that
forwards fields the manifest has not named. This is a stated guarantee rather than an
implementation detail, and it holds for every emitter, present and future — the boundary is the
mapper, which every emitter shares.

**Additive drift is named, not merely detected.** The `contract:` block gains an optional `shape`
— the recorded response shape as sorted `path → type` pairs, the same structure `fingerprintShape`
already computes and currently discards after hashing. `verify` diffs the live shape against it
and reports **which** paths were added, removed, or retyped.

**Adoption is an explicit, reviewable act.** `archstone adopt` takes named fields into the
resource and the binding's mapping, recompiles, and re-records the fixture. It prints a diff, it
is never run unattended, and its output lands in the customer's repository as a normal change to
be reviewed like any other.

The loop is therefore: *the provider grows a field → the next `verify` names it → a human adopts
it in one command → the model gets it with a declared type and a description.*

### Why forwarding was rejected

This is the part to disagree with if you are going to.

**Everything exposed to AI must be discoverable.** A forwarded field arrives with no declared
type, no description, and no guarantee it will be there next call. The model has to infer what
`distanceToBeachM` means from its name. The product's own claim — stated in the README — is that
an assistant can answer "is there a beach nearby?" *from the declared shape, before calling the
tool*. Forwarding forfeits precisely the property we sell, in exchange for data the model then
has to guess about.

**Security is part of the architecture, not a layer over it.** In this domain the payloads are
not neutral. Hotel and booking APIs routinely carry net rate beside selling rate, supplier cost,
commission, and opaque rate keys; booking responses carry guest names and emails. "Forward
whatever is new" makes the provider's next deploy a disclosure decision taken by nobody — and the
first party to notice would be a customer reading a margin off a chat reply.

**Contract integrity.** `outputSchema` would stop describing the output. `verify`'s drift signal
would lose its meaning, since arbitrary additions would be normal. And the contract-violation
error's "raw body withheld" — the sentence the entire fail-closed story rests on, pinned
byte-for-byte by five shipped assertions — would become conditionally false. A guarantee with a
flag that disables it is a default, not a guarantee.

**The weaker version fails too.** An opt-in `passthrough:` on a binding was considered and
rejected in the same breath: it still forwards undeclared data, it still forfeits discoverability,
and it converts a guarantee we can state in one sentence into one that requires reading every
binding in the manifest to evaluate. A new concept has to eliminate more complexity than it adds;
this one adds a permanent primitive whose only function is to disable a property customers are
told they have.

### What `shape` commits us to

`contract.shape` is a **snapshot of an implementation**, not a CDL primitive. It sits in the
binding — the file CDL deliberately keeps outside the language — so the permanence rule applies to
the published wire format, not to the grammar a customer authors against. It records paths and
types only. **It never records values**, which is what makes it safe to commit to a repository
that a booking provider's response has passed through.

## Consequences

**Accepted:**

- `contract.shape` is permanent in the published contract format once shipped. It is additive and
  optional: a contract without it degrades to exactly today's behaviour, so no existing manifest
  changes meaning.
- Manifests grow. A shape is one line per leaf path; for a typical stay resource that is a dozen
  lines of binding, in a file already dedicated to implementation detail.
- **The demo is one step longer.** "It told us, and adopting it was one command" replaces "it just
  worked." We take this deliberately: the shorter story is one we would have to stop telling the
  first time someone asked what else gets forwarded.
- We owe the drift signal a quality bar it did not have before. Naming fields means naming them
  correctly; a diff that reports noise is worse than a hash that reports nothing.

**Rejected:**

- Recording the response **body** in the fixture instead of its shape. It would make the diff
  trivial and put real provider payloads — prices, availability, and on some endpoints personal
  data — into the customer's git history permanently.
- Auto-adopting named fields without a human. It converts a governance decision into a build step,
  which is the failure two adjacent decisions already exist to prevent elsewhere in the compiler.

**Risks:**

- **R-1 — The adoption command is run blindly.** If it becomes a reflex, the human review this
  decision rests on evaporates and we have built forwarding with extra steps. Mitigation: it
  prints the diff and requires confirmation, it is never wired into CI, and its output is a
  reviewable commit. *(M/M)*
- **R-2 — Shape entries leak information through path names.** A recorded path such as
  `$.stays[].guestEmail` is itself informative even though no value is stored. This is strictly
  less exposure than a fixture body and no more than the binding's own field map already implies,
  but it is real and worth stating rather than discovering. *(L/L)*
- **R-3 — Amber fatigue.** A provider that adds fields often will keep `verify` yellow. Yellow
  does not fail the CI gate (only red does), so the risk is that it is tuned out rather than that
  it blocks. *(M/L)*

**Out of scope, so it is not searched for later:**

Auto-migrating a renamed or retyped field — the diff will name it, but deciding that
`price_per_night` *is* the old `pricePerNight` is a judgment no shape comparison can make.
Deriving a contract directly from an OpenAPI document remains deferred.
