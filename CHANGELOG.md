# Changelog

All notable changes to Archstone are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
