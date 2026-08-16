# Changelog

All notable changes to Archstone are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.11.3]

Patch. One CLI usability fix; no library, schema or behaviour change.

### Fixed

- **`archstone --version` and `--help` now exit 0 instead of printing the usage block to stderr
  and exiting 2.** Both matched no verb and fell through to the unrecognized-invocation branch —
  a non-zero exit for a question the CLI had answered correctly, which reads as a broken install
  at the moment a new user is deciding whether the tool works. `--version` (short form `-V`;
  `-v` is left free for verbose) now prints the bare version on stdout, so it is pipeable;
  `--help` (`-h`) prints usage on stdout. An unrecognized verb still prints usage to stderr and
  still exits 2 — that distinction is now the *only* difference between the two paths, which
  share one usage string. Found by installing the published 0.11.2 on a clean machine while
  preparing the launch, i.e. by walking a new user's first two commands.

## [0.11.2]

Patch. Four correctness fixes found during code review of the #45 (rate-limit) and #54
(verify-gate) increments — no schema change, no new public surface.

### Fixed

- **A `scope: provider` `rateLimit` was not actually shared across the capabilities it governs
  (found reviewing #45).** `rateLimitKey` folded `capabilityId` into the bucket key alongside the
  rule's own (globally-unique, BR-4) `id`, so a provider-scoped policy — lowered onto every
  capability under that provider with the SAME rule id — got N independent buckets instead of
  one, silently multiplying a declared `100/min` provider limit into an effective `N×100/min`.
  `rateLimitKey` is now `(ruleId, principal)` only; a capability-scoped rule's id is unique to
  that one capability by construction, so it stays exactly as isolated as before.
- **A malformed `rateLimit` (e.g. `windowSeconds: 0`) silently failed OPEN instead of closed
  (found reviewing #45).** `policy.ts`'s `unevaluatable()` only checked `typeof === "number"` on
  `maxInvocations`/`windowSeconds`, not integer-ness or positivity — unlike the compiler's own
  `policy-ratelimit-invalid` check and `lowerPolicyRules`. A hand-written or forward-versioned IR
  with `windowSeconds: 0` reached `InMemoryRateLimitCounter.increment`, where dividing by a
  zero-length window produces `NaN`; since `NaN !== NaN`, every call looked like a fresh window
  and the limit never triggered. `unevaluatable()` now requires a positive integer for both
  fields, matching the compiler's own standard, so this shape now fails `evaluatePolicy` closed.
- **`archstone verify`'s #54 fix hid more than just retired capabilities (found reviewing #54).**
  `runVerify`'s contract-bearing filter excluded every `invocable:false` tool, which is true for
  both `lifecycle: "retired"` (#54's actual target) AND an unrecognized `lifecycle` value on a
  hand-written or forward-versioned IR (ADD-56's `blockedReason: "unevaluatable"`). A capability
  with a corrupted lifecycle and a genuinely broken contract was silently dropped from the report
  instead of being probed and flagged red — the opposite of ADD-56's "make incompatibility loud"
  goal. The filter now excludes only `blockedReason === "retired"`; an unrecognized-lifecycle
  tool is probed exactly as it was before the #54 fix shipped.
- **Rate-limit metering was order-dependent across a tool's multiple `rateLimit`-bearing rules
  (found reviewing #45).** `evaluateRateLimit` incremented one rule's counter at a time and
  returned as soon as one rule's count was exceeded — rules listed after the denying one were
  never incremented for that call, so which rule "saw" an attempt (and whether a shared/looser
  rule's budget was consumed by a call a stricter rule denied) depended on `policyRules`'s array
  order rather than declared semantics. Every governing rule is now incremented for every call
  (via `Promise.all`) before any exceeded check runs, so the outcome is deterministic regardless
  of rule order.

## [0.11.1]

Patch release. One behavior fix; no schema change (a new authoring-time refusal, not a new
primitive).

### Fixed

- **A `response:`-bound capability with more than one `output:` field is now refused at
  `archstone apply`, not left to crash the reference MCP client at invocation time (#61,
  Option B).** `applyResponseMapping` always returns `structuredContent` with exactly one key
  (the field bound to the mapped resource), while `outputSchema` was built from every declared
  `output:` field — a capability correctly binding one output field to its response (satisfying
  the existing D-7 check) could still declare a second, unrelated field and ship an
  `outputSchema` naming two properties against a `structuredContent` carrying one (the ADD-19
  crash, one level up). New diagnostic `response-output-extra-fields` catches this at authoring
  time. This does **not** lift the underlying one-resource-per-capability cap — #61 remains open
  for that larger decision — it only closes the silent version of the same defect.

## [0.11.0]

Minor release. Behaviour change under 0.x: a manifest that previously failed `apply` solely
because it declared a *complete* `spec.rateLimit` now succeeds and is enforced.

### Added

- **`spec.rateLimit` is now enforced (#45, ADD-45).** Previously `policy.schema.json` declared
  `spec.rateLimit` (`maxInvocations`/`windowSeconds`) but nothing read it — `archstone apply`
  refused it outright (ADD-43 D-2) so a manifest could not silently advertise a control that
  didn't exist. It is now evaluated at the SAME evaluation point as `allow`/`deny` (ADD-43) —
  immediately after that pure check allows, strictly before the backend is ever called — via a
  new pluggable `RateLimitCounter` interface (`increment(key, windowSeconds): number |
  Promise<number>`), threaded through as a new optional, type-only `rateLimitCounter` field on
  `InvokeOptions`/`ExecuteOptions` (same pattern as `auditSink`). An `InMemoryRateLimitCounter`
  reference implementation ships in `@archstone/emitter-support` for dev/tests/single-process
  deployments — **it is not safe on a Workers/edge or multi-instance deployment** (per-isolate
  memory resets); a production deployment supplies its own store-backed implementation (Durable
  Object, Redis, Upstash, …), which stays entirely outside this repo's public core packages.
  Exceeding the limit denies with the identical `policy_denied` shape ADD-43 already ships, under
  a new reason code, `rate_limit_exceeded`.
  - **`spec.rateLimit` now requires BOTH `maxInvocations` and `windowSeconds` together** — a
    document declaring only one is refused at `archstone apply` (`policy-ratelimit-invalid`),
    replacing the old blanket `policy-ratelimit-unsupported` refusal. **Behaviour change under
    0.x, minor bump:** a manifest that previously failed `apply` solely because it declared a
    *complete* `rateLimit` now succeeds and is enforced.
  - **No-store default is FAIL-CLOSED, not degrade-with-a-warning.** A capability declaring
    `rateLimit`, invoked with no `rateLimitCounter` configured, denies every call (reason:
    `policy_unevaluatable`, reused rather than a new code — see ADD-45 §3 for why). A capability
    that never declares `rateLimit` is entirely unaffected and needs no counter.
  - **Key derivation: per capability AND per principal, when a principal is present; per
    capability alone (one shared bucket) when it is not.** There is no per-IP/per-connection
    seam on the invocation path to distinguish anonymous callers further, and Archstone does not
    invent one (out of scope) — see ADD-45 §4.
  - `docs/ONBOARDING.md` gains a "Rate limiting" section documenting how to supply a production
    store.

## [0.10.3]

Patch release. Two behavior fixes; no schema or breaking change.

### Fixed

- **`archstone verify`'s CI release gate no longer breaks permanently when a `contract:`-bearing
  capability is retired (#54, ADD-51 D-6/R-2).** `runVerify` now excludes non-invocable
  (`lifecycle: retired`) capabilities from its contract-bearing filter — a retired capability is
  never probed and never enters the report, rather than being probed forever and turning
  `reports.some(r => r.status === "red")` red the moment its now-stale contract drifts from the
  live backend. Reuses the same lifecycle→exposure computation `Registry.getExposure` is built
  from (`@archstone/emitter-support`'s `lifecycleExposure`) — no second lifecycle check invented.
  `verifyTool` itself is unchanged (still deliberately ungated, per ADD-51 D-6, and still directly
  reachable on a retired capability by a caller who wants one). `policyDenied` entries' gate
  handling is unchanged and out of scope for this fix — a separate decision, deferred.

- **A `resolveCaller` that throws now denies fail-closed instead of escaping as a raw error
  (#48, ADD-42 R-11).** `createHttpHandler`'s per-request call to `resolveCaller` had no
  `try`/`catch` anywhere in `http.ts` — an exception (a JWT parse failure, an unreachable
  session store) propagated as a rejection, surfacing to the MCP client as an opaque 5xx rather
  than a policy decision. It is now caught once, logged to stderr, and turned into a
  `policy_unevaluatable` denial via `callTool` — the same structured, fail-closed shape every
  other unevaluatable-policy case already produces, and deliberately *not* treated as an absent
  (`undefined`) caller, since a resolver that blew up is strictly less trustworthy than one that
  returned nothing. `resolveCaller` stays synchronous (ADD-42 D-1 unchanged).

## [0.10.2]

Patch release. One behavior fix; no schema or breaking change.

### Fixed

- **`@archstone/agent`'s `tools()`/`buildToolDefs()` now honour capability lifecycle (#55).**
  A capability declared `lifecycle: retired` (or `experimental`) was handed to a host's LLM
  identically to a `stable` one — no filtering, no hint text — on the embedded-SDK path only
  (`@archstone/runtime`'s MCP paths, `mcpHandler`/`serveStdio`, already filtered correctly).
  `buildToolDefs()` now consults the same shared `registry.getExposure()` `runtime/server.ts`
  uses: an unlisted capability is dropped from every emitted format (anthropic/openai/gemini/
  json-schema), and a capability carrying a lifecycle hint (`beta`/`deprecated`) has it appended
  to the tool description. No new mechanism — this is the second emitter wiring into the shared
  exposure function ADD-24 built for exactly this reuse.

## [0.10.1]

Patch release. Packaging metadata only — no source, schema or behavior change.

### Fixed

- **`@archstone/init` now ships a README.** The package's npm page had been blank since it
  first published at 0.10.0 — every other publishable package carries one, `init` alone was
  missing it. No code, schema or CHANGELOG-worthy behavior changed.

## [0.10.0]

Minor release. New user-facing functionality, no breaking change: every export, schema and
artifact shipped by 0.9.0 behaves identically. One new published package, `@archstone/init`,
joins the eight that now ship in lockstep; `@archstone/cli` depends on it, so upgrade the CLI
rather than pinning packages individually.

### Added

- **`archstone init` — turn an API you already have into a CDL manifest that compiles (#37,
  ADD-37 with Amendments 1–3).** New public package `@archstone/init` plus a thin `init` verb
  on the CLI: `archstone init <spec-file> --out <dir>`. Point it at an OpenAPI 3.x document
  and it writes `capabilities.yaml`, `*.capability.yaml`, `*.resource.yaml` and
  `bindings/*.binding.yaml` — and an `INIT-REPORT.md` beside them. **No LLM is involved, on
  any path.**

  What makes it worth upgrading for is not the file generation. It is what the tool refuses
  to do:

  - **It is a loop, not a generator.** Before anything is written to your directory, `init`
    materializes the candidate manifest in a temp directory and runs the *real* shipped
    pipeline over it — `load` → `validateSemantics` → `compile` → `new Registry()`. The
    terminal states are "a manifest that compiles was written" or "nothing was written, and
    here is why" (D-7). A compile failure, a tool-name collision, or an empty confirmed set
    writes **zero files**. You never get a half-scaffold to clean up by hand.
  - **It asks instead of guessing.** `effect` is never inferred — a `POST /search` is a
    `read`, and no method-to-effect heuristic survives contact with a real API — so a
    confirmed `effect` exists only in a **Decision Record**, and the pure emitter takes the
    Decision Record rather than any adapter hint (D-3/D-4). Same for a response that can
    honestly be read two ways: an object carrying a scalar payload *and* one incidental array
    is structurally identical to a paginated list wrapper, so `init` enumerates the candidate
    loci and asks which one is the payload rather than picking (D-9/D-14). Genuinely
    unsupported constructs are skipped per-candidate with a named reason code and nothing
    emitted for them — never silently approximated.
  - **It calls your backend only with explicit, per-capability consent, and only to record a
    real fixture.** `--probe` is opt-in and off by default; consent is asked per capability;
    a request is never issued for a capability whose confirmed `effect` is not `read`; a
    non-`GET`/`HEAD` method needs a second, separate confirmation and is refused outright
    when there is no terminal. The recorded golden fixture is written by `recordContract()`
    in `@archstone/runtime` — the *same module*, over the *same* `invokeRest` call, as
    `verifyTool` — so the fixture `init` writes is by construction the artifact
    `archstone verify` later replays (D-6), not a lookalike.
  - **It tells you what it did not understand.** A coverage guard over the OpenAPI reader
    inverts the usual default: each object type declares the keys it *reads* and the keys it
    argues are *inert*, and everything else — including keys from a future OpenAPI revision,
    and keys a contributor forgets to declare — falls through to a note in the report rather
    than being dropped in silence (D-18). Every fact in the intermediate Draft Model carries
    its derivation (`declared` from a spec, `observed` from a real response, or `absent`), and
    the report and the emitted comments are rendered from that provenance, so a
    classification made from N observed items says so instead of claiming to be a
    measurement.
  - **The required/optional rule, stated once and gotten right.** CDL `required: true` only on
    positive evidence of non-nullability — declared-required **and** non-nullable **and** (if
    probed) present and non-null on every recorded item (D-12). The shipped response mapper
    treats `null` identically to `undefined`, so the inverse ships a manifest that goes
    VIOLATION on the first real null.

  The input format is an adapter over the Draft Model, not the architecture (D-1): OpenAPI
  3.x is the first adapter, `$ref`/`allOf` closure and the `oneOf` nullability idiom included;
  adding another touches no file outside `adapters/`. The package root export is pure — no
  fs, no HTTP, no prompts, no clock — with orchestration in `@archstone/init/loop` and the
  terminal in the CLI, so a hosted flow can reuse the core verbatim. Ships with an IR-level
  diff harness that compares a generated manifest against a hand-written one by compiled IR
  joined on connector, which is how the increment measures itself against two independent
  oracles rather than against its own output.

- **`recordContract()` and the `@archstone/runtime/verify` subpath export.** `recordContract`
  sits beside `verifyTool` in the same module and records a golden fixture for a tool that
  does not have a contract yet (`verifyTool` returns `red` before doing anything when
  `!tool.contract`, which is exactly the artifact being created). The new
  `@archstone/runtime/verify` subpath exposes `runVerify` / `verifyTool` / `recordContract` /
  `HealthStatus` without pulling the MCP SDK in through the root index's `serveStdio`
  re-export. Both are additive; the root export is unchanged.

### Changed

- **The README leads with proof rather than with claims**, and a new `CASE-STUDY.md` documents
  the ArtVinci integration end to end. `docs/ONBOARDING.md` gains the `init` path — "start
  here if you have no manifest yet". New `examples/demo/stays-openapi.yaml` (an OpenAPI
  description of the demo's own mock stays backend, in-tree) and `docs/init.gif`, generated
  reproducibly from `examples/demo/init.tape`.
- **Every published package now carries a human description and `keywords`**, replacing
  issue-number shorthand like "CLI (#1): archstone apply". This changes only npm registry
  metadata.

### Fixed

- **The remote-MCP demo Worker hung on a non-`POST` to `/mcp` instead of refusing it (#58).**
  It now answers with an explicit refusal. Demo/example code only — no published package is
  affected.

## [0.9.0]

Minor release, never a patch: `denialReason`'s enum gains a sixth, additive member and
`ExecutionDenialReason`/`Exposure` both widen at the type level — ADD-43 R-3 / ADD-51 OQ-51-A's
precedent for treating a behaviour-changing, type-widening fix as a minor bump under 0.x applies
identically here (ADD-56, D-7).

### Fixed

- **`lifecycleExposure()` had no `default` branch and failed OPEN on an unrecognized `lifecycle`
  value (#56, ADD-56).** The function's `switch` covered exactly the five known `Lifecycle`
  literals; a value outside that set (an unrecognized string, a non-string, or the field absent
  entirely) fell off the end and implicitly returned `undefined`. `Registry`'s constructor stored
  that `undefined` as a real `Map` value, and `getExposure`'s old `?? {listed:true,
  invocable:true}` fallback could not tell a present-but-`undefined` value apart from a missing
  key — the capability became **fully listed and fully invocable**. Reachable only through
  `fromIR` (`@archstone/agent`'s embedded-SDK/MCP surface), which validates only `version ===
  "0"` by design (ADD-0008 D-2) and never runtime-checks `lifecycle` — a hand-written or
  forward-versioned artifact was therefore the only trigger; nothing `archstone build` emits can
  produce it (`lowerLifecycle` always defaults absent-or-unrecognized to `"stable"` at compile
  time). `lifecycleExposure` is now a **total** function: the new `default` branch returns
  `{listed:false, invocable:false}` — the same fail-closed shape as `retired` — so
  `Registry.exposureById` can never again hold `undefined`. As a side effect, this also closes a
  latent, narrower crash: `combineExposure` previously threw a `TypeError` reading `.hint` off
  `undefined` whenever a `Registry` was constructed directly with both an unrecognized-lifecycle
  tool and a covering (non-green) health entry.

  **The refusal is deliberately distinguishable from `retired`'s.** `Exposure` gains one optional
  field, `blockedReason?: "retired" | "unevaluatable"`, populated only when `invocable:false`. A
  `retired` capability is a **governance** fact (a business withdrew it; remedied only by a
  business decision to un-retire it). An unrecognized `lifecycle` is a **compatibility** fact
  (this build cannot evaluate the declared value; remedied only by upgrading the runtime or
  recompiling with a compatible builder). Conflating the two in the audit trail — the same harm
  `policy_unevaluatable` exists to prevent for policy denials — would misattribute evidence to
  someone reading it later. `callTool` (`@archstone/runtime`) and `executeCapability`
  (`@archstone/agent`) now select message text and `denialReason` from this discriminant instead
  of unconditionally hardcoding `retired`'s text/`lifecycle_blocked`, as they did before this
  fix. `retired`'s own message text, `denialReason`, and MCP `_meta[LIFECYCLE_BLOCKED_META_KEY]`
  shape are **byte-for-byte unchanged** — verified by every pre-existing #51 test passing
  unmodified. The new case surfaces on MCP under a distinct `_meta` key,
  `dev.archstone/lifecycle_unevaluatable` (`LIFECYCLE_UNEVALUATABLE_META_KEY`), and on the
  embedded SDK as `ExecuteResult.denial.reason === "lifecycle_unevaluatable"`.

  Two additional, zero-behaviour-change hardening `default` branches land in the same diff:
  `exposure.ts`'s sibling `healthHint` switch and `@archstone/agent`'s `buildToolDefs`'s `switch
  (format)`. Neither is reachable through any untrusted path today (`HealthStatus` values are
  pre-filtered by `readHealthSnapshot`'s allowlist before ever reaching `healthHint`; `format` is
  always supplied by the trusted host calling `tools(format)` directly) — both get an explicit
  `default` anyway, closing the same syntactic pattern everywhere it appears rather than only
  where it was live. `buildToolDefs` now throws a named error identifying the unrecognized
  format instead of silently returning `undefined` where `ToolDef[]` is declared.

  `Registry.getExposure`'s unknown-id fallback also flips, from `{listed:true, invocable:true}`
  to `{listed:false, invocable:false}` — defense in depth on a public method a host can call
  directly with an arbitrary string, bypassing `getCapability` entirely. Verified unreachable
  through all three internal call sites (`callTool`, `executeCapability`,
  `toolDefinitions`/`buildToolDefs`'s listing paths), each of which always resolves `id` via
  `getCapability`/`listCapabilities` first.

  **Two published contracts widen, both additively.** `execution.schema.json`'s
  `status.denialReason` enum gains a sixth member, `lifecycle_unevaluatable`
  (`LIFECYCLE_UNEVALUATABLE_REASON`); `ExecutionDenialReason` (TypeScript) widens to match. Every
  record that validated against the pre-#56 five-member schema continues to validate
  byte-for-byte against the post-#56 six-member one. `Exposure` — exported from
  `@archstone/emitter-support`'s own root and, since `0.8.0`, live on the public npm registry —
  gains the one optional `blockedReason` field described above; no existing consumer
  constructing or reading an `Exposure` value is affected, because nothing reads a field that did
  not exist before and nothing is required to populate one that stays optional. No `IRTool`,
  `Lifecycle`, `LIFECYCLE_STATES`, IR `version`, CDL grammar, or `fromIR` validation change —
  this defect and its fix live entirely below the IR, in how `@archstone/emitter-support` treats
  a value it did not itself validate. `verifyTool`/`archstone verify` is unaffected, on either
  lifecycle case, matching ADD-51 D-6's ruling. `tools()`/`buildToolDefs`'s own exposure-blindness
  (tracked separately, #55) is unaffected and unfixed by this increment.

### Upgrade notes

- **If you have a persisted `archstone.ir.json` built by `archstone build` before v0.6.0
  (before capability lifecycle states existed), upgrading past this release will silently empty
  your tool surface.** This release makes the embedded SDK and MCP server refuse any capability
  whose `lifecycle` value they don't recognize, closing a bug where such a capability was
  previously exposed with no restriction at all. An IR artifact built before v0.6.0 has no
  `lifecycle` field on any of its tools — which now falls into the same "unrecognized" bucket.
  The practical effect: every capability in that file becomes simultaneously hidden from listing
  and blocked from invocation, with no crash and no startup error — the tool surface just looks
  empty.

  **How to tell if you're affected:** open your `archstone.ir.json` and check whether its tool
  entries have a `"lifecycle"` field. If it's missing on some or all tools, or if the file
  predates v0.6.0, you're affected.

  **What to do:** rebuild the artifact — run `archstone build` again using this version (or
  later) of the compiler before upgrading whatever runs it (`@archstone/agent`,
  `@archstone/runtime`) past this release. A freshly built artifact always carries a `lifecycle`
  value on every tool (defaulting to `stable` unless you set one explicitly) and is unaffected by
  this change. There's no way to patch an old artifact in place short of rebuilding it — do this
  before you upgrade, not after.

## [0.8.0]

Minor release, never a patch: `ExecuteDenial.reason`'s published type widens (see "Changed" below)
and `execute()`'s behaviour changes for a `retired` capability — ADD-43 R-3 is the precedent for
treating a behaviour-changing, type-widening fix as a minor bump under 0.x (ADD-51, OQ-51-A,
founder-ratified).

### Changed

- **`execute()`/`executeCapability` now refuses a `retired` capability the same way `callTool`
  already does (#51).** Previously, `@archstone/agent`'s embedded SDK — the surface RFC-0008
  calls the flagship, and the one the bank pilot mounts — had no exposure gate: a capability a
  business had withdrawn (`lifecycle: retired`) still reached the backend through `execute()`,
  while the identical capability over MCP was correctly refused. Since #44 shipped, that
  asymmetry became worse than silent: with an audit sink configured, the trail recorded
  `phase: "succeeded"` for the retired capability's invocation — manufactured evidence that a
  withdrawn capability ran cleanly. `executeCapability` now reads the same ADD-24
  `registry.getExposure(tool.id).invocable` computation `callTool` already reads, checked
  immediately after resolution and strictly **before** policy evaluation, so a capability that is
  both `retired` and otherwise policy-deniable reports `lifecycle_blocked` — never
  `policy_denied` — on both paths. With a sink configured, the refusal is now recorded as
  `phase: "denied"`, `denialReason: "lifecycle_blocked"`, using the existing
  `execution.schema.json` enum member (no schema change). `verifyTool`/`archstone verify` is
  deliberately **not** gated by this change (tracked separately, #54); `tools()`/`buildToolDefs`
  still does not filter or hint on lifecycle (tracked separately, #55).
- **`ExecuteDenial.reason`'s published type widens additively**, from `PolicyDenialReason` to
  `ExecutionDenialReason` (`PolicyDenialReason | "lifecycle_blocked"`) — a type
  `@archstone/agent` already exported. No existing exhaustive `switch` over this field exists in
  this codebase; a downstream consumer doing exhaustive narrowing over the previous four values
  will need a new arm to keep compiling. Recommended as a **minor** version bump, not a patch
  (ADD-51, OQ-51-A, founder-ratified).

## [0.7.0]

Minor release, never a patch: `invokeRest` is a published function and its behaviour changed (see
"Changed" below). It also carries a security fix that was live in published `@archstone/cli` 0.6.0,
accompanied by a GitHub Security Advisory per [`SECURITY.md`](SECURITY.md) rather than a changelog
line alone.

### Security

- **`archstone serve --http` could be killed by one unauthenticated request (#49).** Two vectors,
  both reachable **before any credential check**, because the request body is read and the Web
  `Request` is built before the bearer gate inside `createHttpHandler` runs. A client that declared
  a `Content-Length` and disconnected mid-body, or that sent a malformed `Host`
  (`curl -H 'Host: ['` was enough), made the Node adapter's promise reject; `handleHttpRequest` had
  no `try`/`catch` and was invoked as `void handleHttpRequest(...)`, so nothing could catch it and
  Node's default `--unhandled-rejections=throw` turned it into a fatal uncaught exception. **The
  process terminated** — this was not a failed request. Present since v0.3.0 (#29), when
  `serve --http` was introduced.

  `handleHttpRequest` is now split into three arms by *which operation failed*, not by error shape
  (undici's error shapes are not a stable contract): body read and request construction are client
  faults answered with `400` and **deliberately not logged**; only a handler or serialisation
  failure is a server fault, answered `500` and logged. Logging a pre-auth client fault would have
  traded the crash for a disk-fill denial of service — measured at ~786 bytes of stderr per 60-byte
  unauthenticated request before that was corrected during review. The call site now attaches a
  rejection handler, so a throw added outside those arms cannot resurrect the process death.

- **Unauthenticated request bodies were buffered with no size cap (#50).** Also pre-authentication.
  The body was held roughly 4× over simultaneously (the chunk array, `Buffer.concat`'s copy, and
  undici's copies inside `new Request`) in **external** memory, so `--max-old-space-size` did not
  bound it and the terminal symptom was an uncatchable OOM abort. Now capped at **4 MiB** — the
  limit the MCP SDK already applies to MCP messages arriving over HTTP, rather than an
  Archstone-specific number. A declared oversize is refused on the `Content-Length` header before a
  byte is read; the running total is enforced during streaming as well, because `Content-Length` can
  lie and chunked encoding omits it entirely. Refusals answer `413` with `Connection: close` and are
  not logged.

  **Scope, stated honestly:** both defects and both fixes are confined to the CLI's Node HTTP
  adapter. `@archstone/agent`'s `mcpHandler` and `@archstone/runtime`'s `createHttpHandler` were
  **not affected and are not hardened** by this release — a host mounting them supplies its own
  server, and whatever containment and body limits that server has are the ones that apply.

### Added

- **One policy evaluation point before connector execution (#43, ADD-43).** `policies:` was
  authored in every example manifest and inert except `authenticated`. Policy documents
  (`*.policy.yaml`) now load, resolve onto tools as a neutral `IRTool.policyRules`, and are decided
  by a single pure evaluator in `@archstone/emitter-support` that **all three** invocation paths
  call — `callTool`, `executeCapability`, and `verifyTool`. Denials fail closed and surface as a
  structured `policy_denied` following ADD-19, never a raw pass-through, with one of four reason
  codes. Matching is exact and case-sensitive; any `*` in an `allow`/`deny` entry is a compile-time
  error, so a future wildcard grammar stays a pure widening. Multiple policies compose by
  intersection on `allow` and union on `deny`, with a diagnostic when the intersection is provably
  empty. `spec.constraints` (non-empty) and `spec.rateLimit` are authoring-time errors rather than
  silent no-ops; an empty `constraints: {}` is accepted and never lowered.

  A verify-time policy denial is marked and skipped by the health snapshot, so it never becomes a
  tool-listing hint — without that, a denied capability would be advertised to agents as
  "the last contract verification failed", which is false.

  **Operational note:** policy travels inside the compiled artifact. A deployed
  `archstone.ir.json` that predates a manifest's policy carries no policy and is **not** policed
  until it is rebuilt and redeployed, exactly as it carries stale bindings. The IR version was
  deliberately not bumped, because doing so would reject every artifact shipped to date.

- **`mcpHandler` accepts a per-request caller (#46).** `McpHandlerOptions` omitted `resolveCaller`,
  so no TypeScript consumer could supply per-request identity through the embedded MCP path — the
  only identity reachable was `invoke.caller`, which is fixed at construction time. The wrapper
  already forwarded its options object, so this was a type-level gap with an accidental escape
  hatch (the same value laundered through a `CreateHttpHandlerOptions`-typed variable compiled and
  worked); that path is deliberately kept working. `CallerContext` is now re-exported as a type from
  both `@archstone/agent` and `@archstone/agent/mcp` — naming it previously required depending on
  `@archstone/provider-rest`, a transitive dependency consumers do not declare.

- **`CallerContext.principal`** — an opaque, host-supplied identifier (ADD-42). Archstone never
  parses, decodes, or verifies it; its trustworthiness is exactly that of the host's own
  authentication, and that statement ships with the field rather than after it.

- **`Execution` audit record — one per invocation attempt, including the ones that never reach a
  backend (#44, ADD-44).** `callTool` and `executeCapability` now emit a structured `Execution`
  record for every attempt — `succeeded`, `failed`, and, for the first time, `denied` — so a policy
  refusal, a lifecycle block, a missing caller credential, or an `allowedHosts` rejection all leave
  a trail, not just the ones that made it to a backend. Wired via `auditSink` / `sessionId` /
  `workflowId` on the **existing** options bag across `execute()`, `callTool`, `serveStdio`,
  `createHttpHandler`, and `mcpHandler` — no new parameter, no second construction path.
  `archstone verify` emits nothing, deliberately: a probe replays a golden fixture, and recording
  it would attribute synthetic traffic to whatever principal happened to be on the bag.

  Ships with a reference sink, `jsonLinesAuditSink` (`@archstone/emitter-support`, re-exported from
  `@archstone/agent` and `@archstone/runtime`) — one JSON line per record, to `process.stderr` by
  default or a caller-supplied writable (e.g. a file stream). It refuses `process.stdout` outright,
  at construction, because stdout is the MCP protocol channel on the stdio transport and a logger
  writing there would corrupt every subsequent message.

  A record never carries a credential, a header, a URL, a request body, or a backend's response —
  structurally, not just by scrub: those fields don't exist on the type. What redaction it does do
  is a byte-search-proven substring scrub, generalized to every string field `caller` carries
  except `principal` (code review found and closed a gap here — see Fixed, below). `spec` gains a
  required-but-possibly-empty `policyRuleIds: string[]`, populated identically on every phase; an
  empty list on a capability the manifest governs is the visible signal that the deployed artifact
  predates its policy. `status.denialReason`'s vocabulary grows a fifth member, `lifecycle_blocked`
  — the one refusal the policy evaluator itself can never produce, because the exposure gate that
  blocks a `retired` capability runs before policy is consulted.

  `execution.schema.json` is edited (the enum, and `policyRuleIds`) and is joined to the compiled
  validator set for the first time — every emitted record is now checked against it. **No existing
  behaviour changes when no sink is configured**: no record is built, no clock reading, no id
  generated, no allocation — a strict no-op.

  **The trail is best-effort and lossy by design, and this is not a footnote.** Requirement 3 (never
  break or delay the invocation) and a guaranteed-complete trail cannot both hold, and this increment
  chose the invocation. A sink that throws, rejects, or hangs loses the record it was building — the
  invocation is unaffected, and the only trace is one line to stderr, reported once per failure and
  never deduplicated or rate-limited into silence. **A regulated reader who sees the word "audit"
  will assume completeness unless told otherwise, so this is stated here, not only in ONBOARDING.**

### Fixed

- **A caller-influenced `baseUrl` rejection could leak `caller.tenantId` into an `Execution` record
  (found in code review of #44, fixed before merge).** The redaction scrub was keyed to
  `accessToken` by name; when an `allowedHosts` rejection embedded the resolved (caller-influenced)
  host in its error message, that host — built from a substituted `${caller.tenantId}` — reached
  `status.message` unscrubbed. The scrub is now generic: every non-empty string field `caller`
  carries except `principal`, discovered at `Object.entries` time rather than by name, so the next
  field `CallerContext` grows is covered without further code. Verified by mutation in both
  directions — reverting the fix reproduces the leak; removing its precondition fails the guard
  test loudly rather than passing it vacuously.

- **`execution.schema.json`'s `status.phase` enum drops `pending` and `running` (#53, ADD-44
  Amendment 1).** An `Execution` record models a terminal outcome only — one record is built after
  an attempt concludes (ADD-44 D-1), never an in-flight or partial one — and the enum now reads
  `["succeeded", "failed", "denied"]`, with a `description` added to the schema stating why the two
  removed members must not come back. This is not a behaviour change: `ExecutionPhase` has been
  three-valued in TypeScript since #44's first commit and was never five-valued at any point in
  history, so neither removed value ever had a producer and no consumer could ever have received a
  record carrying one — the schema was the one artifact that had not caught up. Removing an enum
  member is non-additive by nature, which is exactly why it lands now rather than as a routine
  tightening: this schema was joined to the compiled validator set for the first time by #44, and
  0.7.0 is the first release in which anything emits an `Execution` record at all — the only point
  at which this removal is free. After this release ships, the identical edit stops being free and
  becomes a real, if narrow, breaking change.

### Changed

- **`invokeRest` no longer enforces `policies: [authenticated]` — behaviour change on a published
  function (#43).** The gate **moved** to the shared evaluation point; it was removed, not copied,
  because two enforcement sites is the defect this increment exists to remove. The predicate and the
  error message are preserved byte-for-byte, and every caller inside Archstone is gated upstream, so
  `archstone serve`, `archstone verify` and `@archstone/agent` are unaffected. **A third party
  calling the exported `invokeRest` directly loses a fail-closed check** and must call
  `evaluatePolicy` itself. In practice the exposure is narrower than it sounds: a binding that
  references `${caller.accessToken}` still fails on the missing placeholder value, so only bindings
  with no `${caller.…}` placeholder at all are newly reachable without a credential.

- **`LoadResult.policyDocs` is required, not optional**, matching `resourceDocs`. `validateSemantics`
  and `compile` still guard with `?? []`, so a JavaScript caller holding a pre-#43 object degrades to
  "no policies" rather than crashing; a TypeScript caller constructing a `LoadResult` by hand needs
  the field.

### Docs

- `ONBOARDING.md` gains a principal and policy-authoring section, including the
  rebuild-and-redeploy rule above and a note that the CLI wires no identity seam, so a capability
  with an `allow` rule denies everything when served from the CLI.

## [0.6.0]

Minor release: capability lifecycle states and binding health now drive what `archstone serve`'s
MCP tool listing shows and allows — additive and backward-compatible.

### Added

- **Lifecycle-aware MCP tool listing (#24, ADD-24).** A capability may now declare a `lifecycle`
  of `experimental`, `beta`, `stable`, `deprecated`, or `retired`; an absent `lifecycle` field
  defaults to `stable`, so every pre-existing manifest keeps behaving exactly as before. `archstone
  serve`'s `tools/list` now honors it: `retired` capabilities are hidden from the listing and
  blocked from `callTool` outright; `experimental` capabilities are hidden from the listing but
  remain invocable by id; `beta` and `deprecated` capabilities stay listed and invocable, with a
  hint appended to their description (e.g. "beta — interface may still change" /
  "deprecated — avoid new usage"). A binding's health status, as last recorded by `archstone
  verify`, composes into the same listing as an additional description hint when degraded — it
  never gates invocation on its own, and a missing or malformed health snapshot fails open
  (lifecycle-only exposure), so `archstone verify` never becomes a hard dependency for `serve`.
  Touches `packages/compiler` (new `IRTool.lifecycle` field), `packages/schema` (typed model),
  `packages/emitter-support` (new pure exposure-lowering function, composed into the Registry), and
  `packages/runtime` (health-snapshot file read, `server.ts` listing/invocation wiring). Zero
  breaking change to the IR, CDL grammar, or existing tool behavior.

## [0.5.2]

Patch release: test-only reliability fix, no code or package behavior changed.

### Fixed

- **Flaky `durationMs` timing assertion in the `onResponse` hook test suite (#39).**
  `S-US1.4` measured an artificial `fetchImpl` delay via `Date.now()`-based `durationMs` and
  asserted against a threshold with almost no headroom over the nominal delay, so clock/timer
  jitter on a slower or virtualized CI runner (as seen in the public mirror's own post-publish
  CI run) could intermittently fail it. Widened the artificial delay from 30ms to 50ms and
  loosened the assertion from `>=30` to `>=35`, giving genuine slack without weakening what the
  test actually verifies. Test-only change — `invokeRest`'s `onResponse` hook behavior is
  unaffected.

## [0.5.1]

Patch release: documentation only, no code or package behavior changed.

### Docs

- **Local-model MCP path (Ollama, LM Studio) documented (follow-up to #23 spike).** #23
  confirmed `archstone serve` needs no code changes to work with local models — it already
  speaks stdio MCP, and any MCP-capable local client (Ollama via `ollmcp`, LM Studio, or
  otherwise) can attach directly. `ONBOARDING.md` gains a "Local models (Ollama, LM Studio, or
  any other MCP client)" section (between "Step 6 — Serve it to an AI agent" and "Acting on
  behalf of the end user"), and `examples/demo/README.md` gains a matching "Local models
  (Ollama, LM Studio)" section with a copy-paste `ollmcp` config verified end-to-end against
  the tourism demo.

## [0.5.0]

Minor release: an observability hook for bound-capability LLM spend, plus documentation of the
orchestrating-model spend boundary it deliberately doesn't cover.

### Added

- **Raw-invocation observation hook (#39, follow-up to #31 spike).** `InvokeOptions` gains an
  optional `onResponse` callback, fired exactly once per completed HTTP round-trip (2xx or non-2xx
  backend response) with the raw, unmapped response body — before response-mapping or VIOLATION
  logic runs. Use case: observe cost/audit data when a bound capability's own connector calls a
  paid-LLM backend (e.g., a summarization tool whose endpoint is Anthropic's Messages API). Hook
  never fires on early fail-closed returns (no connector, missing env/caller, policy gate,
  disallowed host, missing path param) or network exceptions; any hook exception is caught and
  logged to stderr, never propagated into the invocation's own result. Archstone does **not**
  parse or normalize a provider's usage shape — binding authors extract what they need from the
  raw response using their knowledge of their own backend. Zero IR, CDL, or schema change; passed
  through by `@archstone/agent`'s `execute()` and all `@archstone/runtime` emitters
  (stdio/HTTP/verify) via existing generic `InvokeOptions` plumbing.

### Documentation

- **Orchestrating-model spend boundary (#40, follow-up to #31 spike).** `ONBOARDING.md`'s
  Embedding onboarding section gains "Observing cost & usage data from backend invocations,"
  stating plainly that orchestrating-model spend tracking is out of Archstone's reach by
  construction — that call lives entirely in the consumer's own model SDK, which already returns
  usage data natively (`usage` on Anthropic/OpenAI, `usageMetadata` on Gemini) — and pointing to
  the `onResponse` hook above (#39) as the answer for the other case, a bound capability whose own
  backend bills per token.

### Changed

- **Manifest ownership migration (#35).** ArtVinci's real, production-verified capability manifest
  has been retired from `archstone/examples/manifests/artvinci/` — its sole source of truth now
  lives in `artvinci-website`'s own repository, per Issue #34's ratified manifest-ownership
  pattern (a business's CDL lives in that business's own repository, not in Archstone's
  example tree). This is a relocation of ownership, not a partnership change — ArtVinci's
  capabilities and bindings remain live and functional in their new home. The #26 regression
  test for `rest.query` snake_case remapping has been migrated to a synthetic `query-remap`
  fixture under `providers/rest/test/fixtures/`, preserving regression coverage without
  depending on ArtVinci's real contract. `scripts/release-gate.mjs`'s `VERIFY_PENDING_NO_CI_BACKEND`
  carve-out is now empty (was `{"artvinci"}`); the gate runs `bank`, `booking`, and `tourism`
  manifests only. No package code changed, no IR change.

## [0.4.1]

Patch release: proactive hardening, no behavior change for any existing binding.

### Security

- **Allowlist for caller-influenced `baseUrl` (follow-up to #32).** `InvokeOptions` gains
  `allowedHosts?: string[]` — a deployer-level (static, not per-invocation) host allowlist,
  each entry an exact hostname or a `"*."`-prefixed subdomain wildcard. `invokeRest` now fails
  closed whenever a binding's `rest.baseUrl` template contains a `${caller.…}` placeholder
  (e.g. per-tenant routing via `${caller.tenantId}`) unless the resolved host matches an entry
  in `allowedHosts`; undefined/empty is the secure default. No shipped binding uses `${caller.…}`
  in `baseUrl` today, so this closes a hardening gap proactively rather than fixing a live
  incident — a caller-controlled value in `baseUrl` could otherwise redirect the entire outbound
  request (and any attached credentials) to an arbitrary host, unlike a caller-controlled value
  in headers/body, which can only affect request content. `${VAR}`/env-only bindings are
  unaffected. The compiler emits a matching advisory warning
  (`caller-influenced-baseurl-no-allowlist`) when a binding's `baseUrl` uses `${caller.…}`.

## [0.4.0]

Minor release: a capability can now be invoked on behalf of an end user, not just a shared
service account, and `policies:[authenticated]` goes from an authored label to something the
runtime actually enforces.

### Added

- **Caller-credential propagation & `policies:[authenticated]` enforcement (#32).** A new
  per-invocation `CallerContext` (`accessToken`, reserved `tenantId`) threads through
  `@archstone/provider-rest`'s `invokeRest`, `@archstone/agent`'s `execute()`
  (`ExecuteOptions.caller`), and `@archstone/runtime`'s stdio (`serveStdio`'s new `invoke`
  parameter) and per-request HTTP (`createHttpHandler`'s new `resolveCaller` hook) paths. A
  binding attaches the credential with a new `${caller.NAME}` placeholder alongside the
  existing `${VAR}`/env resolution (e.g. `Authorization: Bearer ${caller.accessToken}`) — no
  IR or schema change. `invokeRest` now fails closed, before any network call, when a
  capability declares `policies:[authenticated]` and no caller credential is supplied on
  invoke; capabilities and bindings that don't use `authenticated`/`${caller.…}` are byte-for-
  byte unaffected. The compiler emits a new advisory warning
  (`authenticated-capability-no-caller-placeholder`) when an `authenticated` capability's
  binding never references `${caller.…}`. `tenant-scoped` remains explicitly unenforced this
  increment. The `bank` example manifest gains a binding for `banking.list-accounts` as the
  end-to-end fixture.

Design: ADD-32.

## [0.3.2]

Patch release: fixes a real round-trip bug in the embedded agent SDK where a tool name
returned by `tools()`/`buildToolDefs()` could not be resolved by `execute()`.

### Fixed

- **`tools()`/`execute()` sanitized-name round-trip (#30).** `tools()` and `buildToolDefs()`
  emit sanitized capability ids (dots → underscores, e.g. `tourism.search` →
  `tourism_search`), but `executeCapability()` only resolved the raw dotted id, so handing a
  model the tool name it was given and calling `execute()` back with it failed with
  `unknown capability`. `Registry` now carries a `byName` index (sanitized name → capability)
  alongside the existing `byId` index; `getCapability()` tries `byId` first, then `byName`, so
  either id form resolves. Sanitized-name collisions are surfaced as
  `Registry.toolNameCollisions` and checked at every callable-Registry construction site
  (`@archstone/agent`'s `fromIR`, `@archstone/runtime`'s `buildRegistry`, and the CLI's
  `runApply`/`runBuild`) — a collision refuses to build a callable registry rather than
  silently misrouting a call. `archstone build` now also gates on registry construction,
  closing a gap where it could previously emit an IR artifact with no registry-level
  validation at all.

Reviewed: BA → principal-architect → developer → code-reviewer pipeline, approved (non-blocking
findings only). Design: ADD-30.

## [0.3.1]

Patch release: fixes a real bug in the published `@archstone/provider-rest@0.3.0` where REST
query parameters were sent using CDL field names instead of the wire-expected names (e.g.
`widthCm` instead of `width_cm`), causing strict-schema consumers to reject requests. Also
includes a related, additive IR change reviewed together with the fix.

### Fixed

- **REST connector query-param remapping (#26).** A binding's `connector` can now declare a
  `rest.query` map — CDL field name → wire query-param name (e.g. `widthCm` -> `width_cm`) —
  mirroring the decoupling `response.map` already gives resource fields vs. provider JSONPaths.
  Fixes real requests built by the previously-published `@archstone/provider-rest@0.3.0`, which
  sent query params verbatim under their CDL names; a consumer with a strict schema (e.g. Zod)
  on the receiving end would 400 on those requests. `buildQuery` remains fully backward
  compatible when no `query:` block is present — CDL field names are used verbatim, byte-
  identical to the prior behavior. Replaces the artvinci binding's path-embedded-query
  workaround with a proper `query:` map.
- **`ref:` fields lower to bare identity, not full resource shape (#25).** A capability input
  typed `ref: SomeResource` now lowers to a plain identifier in the IR (`identity: true` on the
  `resource` IR type arm) instead of the resource's full field shape, so an MCP `inputSchema`
  asks for an id (`{"type": "string"}`), not a nested object. Additive — no IR `version` bump.
  Same treatment applies to a `ref:`-originated field nested inside another resource's own
  field map.

Reviewed together (✅ Approved). Design for #25: ADD-25.

## [0.3.0]

RFC-0008 (embedded agent emitters), slices 1-3: the IR can now be consumed directly by an
embedding host process, without going through the MCP transport at all.

### Added

- **`@archstone/emitter-support`** (#27). New package: the shared, target-agnostic substrate
  every emitter needs — Registry indexing, semantic-type → JSON-Schema lowering, and the
  response-mapping executor — extracted out of `@archstone/runtime`. MCP-SDK-free, fs-free, so
  a future embedded consumer (`@archstone/agent`) never gains a static edge to either. Pure
  relocation: zero logic drift, zero behavior change to the existing stdio/response-mapping/
  verify test suites.
- **`archstone build <dir>`** (#27). New CLI verb: compiles a manifest straight to a versioned,
  contract-stripped `archstone.ir.json` artifact on disk, for embedding hosts that want the IR
  without spinning up a server.
- **`@archstone/runtime` `/http` subpath** (#27). New fs-free Streamable HTTP transport
  (`createHttpHandler`) — the one shared transport both `@archstone/agent`'s `mcpHandler` and
  `archstone serve --http` build on. Requires a bearer token at construction (throws
  synchronously before any request handling if absent — fail-closed, not per-request); no CORS.
- **`@archstone/agent`** (#28). New package: the embedded agent SDK.
  - `fromIR()` — fail-closed version check, builds a Registry from a compiled IR.
  - `tools(format)` — thin envelopes over `@archstone/emitter-support`'s lowering for
    `anthropic` / `openai` / `gemini` / `json-schema` dialects.
  - `execute()` — composes REST invocation → response mapping into a 4-state result
    (`ok` / `degraded` / `violation` / `error`); Workers-safe env handling, never falls back to
    `process.env`.
  - Root entry has zero `@modelcontextprotocol/sdk` reachability, enforced by a boundary test —
    embedding `@archstone/agent` in a host process never pulls in the MCP SDK transitively.
- **`@archstone/agent/mcp`** (#29). New subpath: `mcpHandler()`, a mountable Streamable-HTTP MCP
  handler built on `@archstone/runtime`'s `/http` transport — for hosts that want to expose the
  IR as MCP tools without running `archstone serve`.
- **`archstone serve --http`** (#29). New CLI flag: serves MCP over Streamable HTTP instead of
  stdio. Requires a bearer token (`--token` or `ARCHSTONE_HTTP_TOKEN`); fails closed and never
  binds a port if neither is set — never starts, let alone 401s, without one configured.

### Changed

- `@archstone/runtime`'s response-mapping module (`src/mapping.ts`) now re-exports
  `applyResponseMapping` from `@archstone/emitter-support` instead of implementing it —
  non-breaking, existing imports from `@archstone/runtime`'s root entry are unaffected.

## [0.2.0]

### Added

- **Typed resource output.** `*.resource.yaml` definitions are now loaded and resolved by the
  compiler: a capability output field like `collection: Stay` (or any `ref`/resource-typed
  field) resolves against a named resource, and the MCP emitter lowers the resolved fields
  into a typed, described `outputSchema` on the tool. Agents now see a resource's real shape
  (e.g. `Stay.name` / `location` / `pricePerNight` / `rating`) instead of a bare
  `{type: object}`/`{type: array}`.
- **Response mapping.** A binding may declare a `response:` block that maps a live provider's
  HTTP response onto the resource its tool outputs (`collection` JSONPath + a resource-field →
  provider-path `map`). At invocation, the runtime applies the mapping and validates it against
  the resource's required fields:
  - all required fields present → **OK**, mapped data returned as `structuredContent`;
  - an optional field missing → **DEGRADED**, returned with that field omitted and a warning;
  - a required field missing → **VIOLATION**, fail-closed — `isError:true` with a human-readable
    `content` message plus a structured error in `_meta["dev.archstone/contract_violation"]`
    (`{error: "contract_violation", capability, missing}`) — never a raw pass-through of the
    provider's body. Agents branch on the structured field, not parsed prose.
- **`archstone verify`.** New CLI command. For every binding with a `contract:` block, it
  replays the recorded request in `fixtures/<capabilityId>.golden.json` against the **live**
  backend, runs the response through the same mapping a real tool call would use, fingerprints
  the response shape, and reports a per-binding health status (🟢 unchanged / 🟡 shape drifted
  or degraded / 🔴 a required field is missing or the request failed). Exits non-zero on any
  🔴, so it drops into CI as a contract-drift gate. It is the only command that makes a live
  network call outside a real tool invocation, and is on-demand only — never triggered by
  `apply` or `serve`.
- **`archstone verify --json`.** Optional flag for `archstone verify` that renders per-binding
  health status as structured, machine-readable JSON instead of human emoji lines, so CI
  pipelines, dashboards, and ops tooling can consume health data programmatically. Two disjoint
  output shapes: `{results: [{capabilityId, status, detail}]}` on success (empty array when no
  bindings declare a contract), or `{error: "manifest_invalid", issues, errors}` when the
  manifest fails to load or validate. Exit codes unchanged (0 no-red / 1 any-red / 2 invalid).
  Stdout contains only the JSON document with no extra banner or log lines mixed in.

### Changed

- A capability output that references an unresolved resource name is now a **compile error**
  (`unknown-resource`) instead of silently lowering to a generic `object`/`array`.

### Breaking

- Manifests using `collection:`/`ref:` output fields need a matching `*.resource.yaml` to
  compile. See [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for how to author one.

## [0.1.0]

Initial MVP walking skeleton: CDL manifest → schema validation → semantic validation →
compile to IR → MCP tools served over stdio, demoed end-to-end against Claude Desktop.
