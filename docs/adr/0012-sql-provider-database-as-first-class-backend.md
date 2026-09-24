# ADR-0012: A Database Is a First-Class Backend — the `sql` Provider

**Status:** 🚧 Draft — not accepted. Circulated for review; nothing in this document is
implemented and no schema/IR change described here has landed.

**Note:** two independent architect drafts of this decision existed. This one — with connector
dispatch centralized once in a new subpath (D-6) — was chosen by Adrian on 2026-09-24 over the
alternative, which kept dispatch per-consumer. The superseded draft is kept for reference at
`0012-sql-connector-database-as-first-class-backend.md.rejected`.
**Date:** 2026-09-23
**Deciders:** Adrian Bratulescu (pending)
**Related:** [ADR-0005](0005-open-core-boundary-artifact-guarantee.md) ·
[ADR-0008](0008-undeclared-provider-data-never-reaches-a-model.md) ·
[ADR-0011](0011-undeclared-model-output-never-reaches-a-business-system.md) ·
`providers/rest` (the `rest` connector this design is symmetric with) ·
internal ADD-18 (contract probe/health), ADD-30 (tool-name/registry centralization),
ADD-32 (caller credential propagation), ADD-37 (`archstone init` inference loop),
ADD-42 (caller principal) — cited throughout for precedent; their numbering is internal
and does not correspond to this repo's ADR sequence.

---

## Context

A capability's binding today maps to exactly one implemented connector: `rest`. Everything
`archstone` knows how to *do* with a backend — resolve `${VAR}`/`${caller.NAME}` placeholders,
build a request, map a declared response shape onto a resource, probe and diff a contract,
gate on a policy — is expressed once, in `providers/rest`, and read generically by the compiler
and by every invocation path through `IRTool.connector`.

A large class of capabilities are `SELECT ... WHERE` over a company's own database with no
business logic in between. Exposing them today requires standing up a REST endpoint whose only
job is to be reachable from `archstone` — a controller, a serializer, an auth check and a
deployment that exist to satisfy the transport, not the business. `connector.schema.json`
already reserves `"sql"` in its `type` enum (alongside `"graphql"`, `"grpc"`, `"soap"`), but
nothing implements it: `IRConnector["type"]` accepts the string, `compile.ts`'s
`lowerConnector` lowers it to a bare `{ type: "sql" }` with no body, and no `invokeX` function
exists to act on it. A capability bound this way today compiles, is listed as invocable (`.connector`
is truthy), and fails at the first call with no useful error.

This ADR designs the `sql` provider: a second, first-class connector, symmetric with `rest`,
binding a capability directly to a Postgres database. It is scoped narrowly and deliberately —
see the constraints below, drawn from the approved product brief
(`internal/docs/product/brainstorming/sql-provider-database-as-first-class-backend-pm.md`) and
**treated here as fixed, not re-opened**:

- Postgres and the Postgres wire family only (self-hosted, RDS/Aurora, Supabase, Neon) — no
  Snowflake, BigQuery, MySQL, SQL Server, Mongo in v1.
- Read-only (`SELECT`) — no writes, no mutations, in v1.
- No agent-authored SQL, ever. No table name, column name, engine, or connection string may
  appear in a `*.capability.yaml` — only in the binding, exactly as CDL already requires for
  every implementation detail (RFC-0001).
- Isolation — "a caller sees only their own rows" — is enforced by the database (Postgres RLS,
  typically via a curated schema of security-barrier views as the documented default topology,
  with RLS on base tables as a supported alternative) and by a runtime role that is not the
  table owner and does not hold `BYPASSRLS`. A binding that omits a tenant predicate must still
  return zero foreign rows. The YAML author is not part of the security boundary.
- v1 ships tenant-of-deployment isolation (one deployment, one tenant, resolved once per
  invocation). Per-end-user isolation is a later increment and must not require a rewrite of
  this one — it is designed for by using a per-invocation *session-identity* mechanism now
  rather than "one connection string per tenant."
- Identity arrives as the already-ratified opaque caller **principal** (internal ADD-42), mapped
  to identity claims by a deployer-supplied adapter. `tenantId`/`userId` are never read from
  model/capability input.
- Free core, Apache-2.0, no paywall on `serve` or on running a compiled artifact (ADR-0005). No
  console dependency, no `if (isSaaS)` anywhere in this design.
- `archstone init` proposes capabilities from `information_schema`, the way the OpenAPI adapter
  proposes them from a spec, and `archstone verify` proves isolation — a negative test, foreign
  identity → zero rows — that can fail a build.

What follows is this ADR's own decision: the binding grammar, the identity seam, the
transaction/session mechanics, the connection lifecycle, the contract/fixture shape, where the
isolation test lives mechanically, how an over-privileged connection is detected, and how
`init`'s Postgres adapter fits the existing compile-and-probe loop precedent.

---

## Decision

### D-1. Binding grammar — a declared, parameterized query; no query-text templating, ever

A binding's `connector.sql` block, symmetric with `connector.rest`:

```yaml
# bindings/portfolio.summary.binding.yaml
binding:
  capabilityId: portfolio.summary
  connector:
    type: sql
    sql:
      engine: postgres
      dsn: "${DATABASE_URL}"
      statementKind: select
      query: |
        SELECT id, week_ending, headline, delta_pct
        FROM reporting.portfolio_summary_v
        WHERE id = $1
      params:
        - id
  response:
    resource: reporting.PortfolioSummary
    collection: "$[*]"
    map:
      id: id
      weekEnding: week_ending
      headline: headline
      deltaPct: delta_pct
```

- **`dsn`** resolves via the existing `${VAR}` env-placeholder mechanism, unchanged — the same
  `resolveEnv` REST's `baseUrl` already uses. A literal connection string in a binding is
  refused at `apply` the same way a literal secret in a header would be flagged today (same
  discipline, no new mechanism).
- **`query`** is the entire declared SQL text, author-controlled, static, and — this is the
  load-bearing property — **never templated with a caller-influenced value**. There is no
  `{field}`/`${caller.NAME}` substitution inside `query` at all; the grammar does not offer one.
  Only the fixed **positional parameter list** (`params`, an ordered array of declared CDL input
  field names) is bound, through the driver's native parameterized-query API (`pg`'s
  `client.query(text, values)`), to the query's `$1, $2, …` placeholders. This is what "declared,
  parameterized query" means concretely: the shape of the query is fixed at authoring time; only
  values move at invocation time, and they move through the driver's own escaping, never through
  string concatenation. A `query` referencing a name not in `params`, or a `params` entry naming
  an undeclared CDL input field, is an `apply`-time error — the same "ambiguous is a refusal, not
  a guess" discipline `compiler/src/resolve.ts` already applies to resource names.
- **`statementKind: select`** is required and, in v1, only `"select"` validates
  (`connector.schema.json` closes the enum to one value now; `"insert"`/`"update"`/`"call"` are
  reserved names for a later, narrower write increment — not built here). This is the first of
  three independent read-only enforcements (D-9).
- **No identity placeholder exists in this grammar, on purpose.** `${caller.principal}` /
  `${caller.tenantId}` are a REST-only construct (ADD-32/42) and are deliberately **not**
  offered on `sql.query`/`sql.params`. Identity never flows through binding-authored text — see
  D-3/D-4. This is the concrete mechanism behind the product constraint "the YAML author is not
  part of the security boundary, and cannot widen it": there is no field in this grammar an
  author could use to *reference* identity even if they wanted to.
- **Response mapping is unchanged, reused verbatim (D-7).** `binding.response`/`response.schema.json`
  already express "a JSONPath into a list of items, mapped field-by-field onto a resource" — a
  SQL provider that returns its row array as the tool's raw response body needs nothing new here.

### D-2. `connector.type: "sql"` carries an engine discriminator now; the other stubs are named, not silently carried forward

`connector.schema.json`'s `type` enum already reserves `graphql`/`grpc`/`soap`/`sql`. This ADR:

- Adds a required `sql.engine` field, closed to `"postgres"` in v1 (Challenge 2 of the product
  brief: the Postgres wire family shares one isolation mechanism; a portable "SQL" abstraction
  across engines would silently degrade to the weakest one's guarantee — refused, not built).
  `engine` exists so a later Snowflake/BigQuery increment is additive (`"snowflake"` joins the
  enum) rather than a `type` fork, while making it schema-legible today that `"sql"` is not yet
  portable.
- Leaves `graphql`/`grpc`/`soap` exactly as reserved, unimplemented enum members — **but adds one
  small, in-scope fix**: today a capability bound to any of those types compiles, is treated as
  invocable (`IRTool.connector` is truthy), and fails only at the moment of invocation with an
  opaque error, because nothing checks connector *implementedness* before that point. This ADR's
  new `invokeConnector` dispatch (D-6) is the one place that already has to know the closed set
  of implemented types, so it is also the one place a `compiler/src/validate.ts` diagnostic
  should fire: `connector.type` is `graphql`/`grpc`/`soap` → an `apply`-time **error**
  (`connector-type-not-implemented`), not a runtime surprise. This is a pre-existing gap this
  ADR's work makes visible, not new scope for the `sql` provider itself; it is included because
  the alternative — leaving it — means `sql` becomes the second connector type silently exempt
  from a check the codebase never had.

### D-3. The identity-adapter seam, and why `CallerContext` moves out of `providers/rest` now

Internal ADD-32 D-2 declined to move `CallerContext` out of `providers/rest` into the shared
substrate, explicitly deferring the move to "the trigger ADD-32 R-1 already named: the first
non-REST connector." This is that connector.

**Move.** `CallerContext` and the connector-agnostic half of `InvokeOptions`
(`env`, `fetchImpl`, `caller`, `auditSink`, `sessionId`, `workflowId`,
`callerResolutionFailed`, `rateLimitCounter`) relocate to `@archstone/emitter-support` as the
shared, connector-agnostic invoke-context shape. `providers/rest`'s `InvokeOptions` becomes an
extension of that base adding only what is genuinely REST-specific (`allowedHosts`,
`onResponse`) — the pattern REST's own `${caller.NAME}` interpolation already establishes for
what stays local to a connector. `providers/rest` re-exports `CallerContext` as a type alias so
no existing `import type { CallerContext } from "@archstone/provider-rest"` call site breaks —
a non-breaking, type-only migration. `providers/sql`'s `InvokeOptions` extends the same base.

**The new seam.** A capability bound to `sql` needs one further mapping the REST world never
needed: **principal → identity claims** (`{ tenantId }` in v1; `{ tenantId, userId }` later,
per the product brief's phase-coherence argument). This is a deployer-supplied pure function,
carried as one new field on the shared base `InvokeOptions`:

```ts
identityAdapter?: (principal: string | undefined) => Record<string, string> | undefined;
```

- It is **not** a per-request extraction hook like `resolveCaller` (ADD-32/42). `resolveCaller`
  had to be per-request because it reads the raw inbound `Request`; `identityAdapter` takes the
  *already-resolved* `caller.principal` (resolved once per invocation, identically on every
  entry point, by the existing ADD-42 machinery) and returns a pure derived value. It can
  therefore be set **once, statically, at construction time** — on `ExecuteOptions`,
  `serveStdio`'s `invoke`, and `createHttpHandler`'s options — with **zero** risk of the
  ADD-42 G-1/D-13 class of bug (a per-request clobbering seam that silently falls back to a
  static default). There is exactly one thing to configure and exactly one place it is read.
- **It is read in exactly one place: `invokeSql` (D-4).** No allow/deny decision is made from
  it — it only produces the values the runtime sets as session state before running the
  declared query. This mirrors ADD-42 D-8's placement rule ("identity-based decisions never
  live in a specific provider") generalized to: *identity resolution* is shared/generic
  (`identityAdapter` lives on the shared invoke-context type), but *acting on resolved identity*
  is connector-specific mechanics, exactly as `${caller.principal}` interpolation is REST-only
  mechanics over the same shared `CallerContext.principal`.
- **Absence fails closed.** A `sql`-bound capability whose `identityAdapter` returns `undefined`
  (unset adapter, or an adapter that cannot resolve this principal) refuses the call before any
  connection is used — `invokeSql`'s equivalent of ADD-32's "no caller credential" gate. There is
  no silent "run with no session identity" path; a `SELECT` executed with no GUC set would rely
  entirely on the DBA's RLS policy defaulting to deny-on-absent, which this design does not want
  to depend on as its only safety net.
- **This closes the ADD-30/ADD-42-class drift risk by construction, not by discipline**: because
  `identityAdapter` needs no new per-surface wiring (it rides the same shared `InvokeOptions` bag
  every entry point already forwards, and is invoked from the one dispatch function in D-6),
  there is no second copy of "how do we get identity into this call" for a future third connector
  to duplicate.

### D-4. Transaction/session mechanics — the correctness core

One invocation of a `sql`-bound capability is exactly one Postgres transaction:

```
BEGIN;
SET TRANSACTION READ ONLY;                          -- D-9, structural read-only enforcement
SELECT set_config('app.tenant_id', $1, true);        -- one call per resolved identity claim
                                                      -- ... (one per key identityAdapter returned)
<the declared, parameterized SELECT>;
COMMIT;                                              -- or ROLLBACK on any error
```

- **`set_config(name, value, is_local := true)` is the mechanism the entire isolation guarantee
  rests on, and it is a Postgres guarantee, not an application discipline.** The third argument,
  `true`, scopes the setting to the *current transaction only*: Postgres itself resets it the
  instant the transaction ends, whether by `COMMIT` or `ROLLBACK`, unconditionally, including on
  an unexpected error inside the request handler. This is what makes "a pooled connection cannot
  leak a previous caller's session state" true by construction rather than by careful cleanup
  code: there is no cleanup code to get wrong, because there is nothing left to clean up once the
  transaction boundary closes. A connection is returned to the pool only after `COMMIT`/`ROLLBACK`
  has already run, so the next caller to check it out starts with no residual GUC state from any
  previous tenant — enforced by the database, not by `archstone`.
- **GUC naming is deployer configuration, never CDL/binding content.** `identityAdapter` returns
  claim keys the deployer chooses to match their own RLS policies (e.g. `{ tenant_id: "acme" }`);
  a small `sqlSessionGucPrefix` option on `InvokeOptions` (default `"app."`) determines the
  literal GUC name (`app.tenant_id`). This lives entirely in deployer-supplied `InvokeOptions`,
  exactly like `bearerToken`/`allowedHosts` — a manifest author cannot see it, let alone change
  it, from any CDL or binding file. This is D-1's "no identity placeholder in the grammar"
  restated from the runtime side.
- **`SET TRANSACTION READ ONLY`** is a second, independent read-only enforcement (D-9): even a
  query that somehow slipped past the compile-time `statementKind`/leading-keyword check (a
  comment-obfuscated statement, say) fails at the database with a read-only-transaction error,
  because Postgres enforces this per-transaction unconditionally, not by trusting the query text.
- **Exclusivity.** A connection is checked out of the pool for the duration of exactly one
  transaction and is never shared concurrently across two invocations; standard pool
  checkout/release semantics already guarantee this — no new locking is introduced.
- **Error paths roll back.** Any failure inside the transaction (a bad parameter, a backend
  error, a policy evaluator error before the connector is even reached) results in `ROLLBACK`,
  never a bare connection return with an open transaction — the pool wrapper's `try { … } finally
  { release() }` pattern, with rollback in the `catch`, matches the existing "fail closed, name
  the property" style `invokeRest` already uses for its own error paths.

### D-5. Connection lifecycle: embedded, stdio, HTTP — and exclusion from the stateless edge build

- **Embedded (`execute()`) and `serve --http`.** One `pg.Pool` per process, constructed once
  (at `fromIR`/handler-construction time) and reused across invocations; each invocation checks
  out one connection for its one transaction (D-4) and releases it. Standard, long-lived Node
  process behavior — no change to the "long-running process" assumption `serve --http` already
  makes.
- **`serve` (stdio).** One child process per conversation (the same model ADD-32 already
  established for stdio caller identity) — a pool sized for a single conversation's concurrency
  is architecturally correct here, same as the rest of that surface.
- **Exhaustion / timeout.** A pool-checkout timeout returns the same fail-closed
  `{ ok: false, status: 0, error: … }` shape `invokeRest` already returns for a fetch failure —
  no silent unbounded queuing. Pool sizing defaults small and is a deployer-configured
  `InvokeOptions` field, never a product surface (per the brief: "connection management as a
  product feature... it is not sold").
- **Excluded, by construction, from any stateless/edge (Cloudflare Workers) build.** `pg`
  (the Postgres wire driver) opens a raw TCP socket and holds pooled, stateful connections — both
  incompatible with an edge isolate's per-request, no-persistent-process model, and with the
  "pure mapper + `fetch` + injectable env only" edge-safe surface internal RFC-0008 already
  established. `providers/sql` is therefore a **Node-only package**: it is never imported from
  `@archstone/runtime`'s `http` subpath (the edge-safe entry ADD-0008 built specifically to stay
  fs/TCP-free), and the compiler/IR/`emitter-support` layers stay unaware of it — a manifest
  containing a `sql`-bound capability compiles fine, but is not a candidate for a future edge
  deployment target until a data-proxy decision (Hyperdrive or equivalent) is made on a real
  customer's demand, per the product brief's own phase-coherence framing. No mechanism is built
  for that here; only the exclusion boundary is drawn, deliberately, now.

### D-6. Provider dispatch is generalized, once, in a new subpath — not re-implemented at each call site

Today four call sites — `executeCapability` (`agent`), `callTool` (`runtime/server.ts`),
`verifyTool` and `recordContract` (`runtime/verify.ts`) — import `invokeRest` directly and call
it unconditionally. Adding a second connector type without centralizing dispatch would mean
teaching four places, independently, to branch on `tool.connector?.type` — precisely the
duplicated-mechanism defect class internal ADD-30 already found and fixed once for tool-name
resolution.

**Decision:** add `invokeSql` to a new `providers/sql` package with the same `InvokeResult`
shape `invokeRest` returns, and add one new function, `invokeConnector(tool, input, opts)`, that
switches on `tool.connector?.type` and calls the right adapter (or returns a clean
"connector type not implemented" result for `graphql`/`grpc`/`soap`, and today's existing
"no REST connector" for a mismatched/absent connector). All four call sites switch to
`invokeConnector`; none imports `invokeRest`/`invokeSql` directly any more except
`invokeConnector` itself.

**Where it lives, and why not `@archstone/emitter-support`'s root.** `emitter-support`'s own
header states its purity contract: "IR-only: no MCP SDK, no fs, no HTTP." `invokeConnector`
necessarily depends on both an HTTP-capable package (`providers/rest`) and a TCP-capable one
(`providers/sql`) — putting it in the pure root would break that contract for every existing
consumer of `emitter-support`'s neutral pieces (Registry, the mapper, the policy evaluator). The
fix reuses a precedent this codebase already applied once, for exactly this shape of problem:
internal ADD-37 R-2 kept `@archstone/runtime`'s root pure while adding an I/O-touching
`recordContract` behind a dedicated `@archstone/runtime/verify` subpath — "a bundler can
tree-shake an import, not a method," so a separate subpath keeps the pure root pure for anyone
who never imports the new one. This ADR does the same: `invokeConnector` ships from a new
`@archstone/emitter-support/connector` subpath, in its own source file, leaving `src/index.ts`
(the pure root) untouched. `agent`, `runtime`, and `cli` import the subpath; nobody who imports
only the root pulls in `pg` or `fetch`-adjacent code.

### D-7. Contract/fixture shape — reused verbatim, no IR/schema change

ADD-18's `fingerprintShape`/`ShapeMap`/`ShapeDiff` and `contract.schema.json`/`IRContract`
already operate on `unknown` JSON data by structural shape (sorted key paths + JS value types),
with no assumption about where the data came from. A SQL result set, once row objects are
returned as `InvokeResult.data` (an array, exactly as a REST list endpoint returns a JSON array
body) and passed through the **same, unmodified** `applyResponseMapping`, is indistinguishable
from a REST body at every layer above the connector. Concretely:

- `invokeSql` returns `{ ok, status, data: rows, error? }` — `rows` is the driver's row-object
  array, with native Postgres types coerced to the same JSON-safe representation the driver
  already produces by default (numeric/bigint/timestamp as strings unless a deployer overrides
  type parsers) — so `fingerprintShape` sees the same `string`/`number`/`boolean`/`object`/`array`
  vocabulary it already sees for REST.
- A SQL binding's `response.collection: "$[*]"` + `response.map` are the **existing**
  `response.schema.json` grammar, unchanged. No new binding block, no new IR type for "a SQL
  response."
- `archstone verify`'s probe-and-diff loop (`runVerify`/`recordContract`) needs no change beyond
  routing its one `invokeRest` call through `invokeConnector` (D-6) — the fingerprinting,
  diffing, and health derivation are already connector-agnostic.

**The one additive IR change this ADR requires:** `IRConnector` gains an optional `sql` field
mirroring `rest`:

```ts
export interface IRSqlConnector {
  engine: "postgres";
  dsn?: string;         // ${VAR}-templated, as-authored — resolved at invoke time, never at compile time
  statementKind: "select";
  query: string;
  params: string[];     // ordered CDL input field names bound positionally to $1..$n
}

export interface IRConnector {
  type: "rest" | "graphql" | "grpc" | "sql" | "soap";
  rest?: IRRestConnector;
  sql?: IRSqlConnector;  // NEW — additive, IR.version stays "0" (Rule #11)
}
```

No other IR shape changes. `IRContract`, `IRResponseMapping`, `IRTool`, and the resource
registry are all untouched — the SQL provider is a new leaf under `IRConnector`, nothing more.

### D-8. The negative isolation test — where it lives mechanically

Golden fixtures are already an unschema'd, TypeScript-only artifact (`GoldenFixture` in
`runtime/src/verify.ts`, per internal ADD-37 O-11) — a `verify`-time artifact, not a manifest
input, and explicitly not subject to the "no new schema surface" constraint the same way CDL is.
This ADR extends that interface, not `contract.schema.json`, with one new optional field, present
only for `sql`-connector bindings:

```ts
interface GoldenFixture {
  // ...existing fields unchanged...
  negativeIdentity?: { principal: string }; // a DIFFERENT tenant's principal, sql bindings only
}
```

**Mechanics, inside `runVerify`'s existing per-binding loop, for `sql` connectors only:**

1. Replay the fixture's `request` under the operator's configured verify-time identity (resolved
   through the same `identityAdapter`) — the existing green/yellow/red path, unchanged.
2. If `negativeIdentity` is present, replay the **identical** request under that principal
   (resolved through the same `identityAdapter`, but the different principal produces different
   claims) and assert the result set is **empty**. A non-empty result here is a hard `🔴`, with a
   detail message distinct from every other red cause ("isolation test failed: N foreign rows
   returned for capability '<id>'").
3. If `negativeIdentity` is **absent** for a `contract`-bearing `sql` binding, the binding is
   `🔴` — "isolation not verified: no negative identity recorded" — mirroring success criterion 4
   verbatim ("a binding without a recorded negative result is not verified").
4. **Confirmed behavior, not left implicit:** if `negativeIdentity` **is** present but the
   configured `identityAdapter` cannot resolve it — returns `undefined` for that principal, the
   same "cannot resolve" outcome D-3 already treats as a fail-closed refusal for a real
   invocation — the binding is `🔴`, with its own distinct detail
   ("isolation not verified: negative identity did not resolve to any claims"). This is
   deliberately **the same outcome as case 3 (absent)**, not a separate, softer status and never
   a silent skip or an automatic green: an isolation test that cannot be run is exactly as
   unverified as one that was never recorded, regardless of which of the two reasons produced
   that state. `runVerify` must not distinguish "no negative identity was declared" from
   "a negative identity was declared but could not be resolved" in anything other than the
   detail string — both gate the build identically.

**No new `HealthStatus` value, no new CLI flag, no new exit-code mechanism.** This folds into the
existing red-fails-the-build behavior `archstone verify` already has (ADD-18) — a manifest with a
failing isolation test already fails CI the moment any binding is red. `archstone verify`'s
`--json` output (internal ADD-20's shape) gains this as one more possible `detail`/status
combination on an existing field, not a new top-level key.

### D-9. Detecting an over-privileged connection — mechanism and entry points

**Correction (2026-09-24).** The role-level layer below originally checked only
`pg_roles.rolsuper`/`rolbypassrls` and claimed to cover "superuser, table owner, or
`BYPASSRLS`." That claim was wrong: table ownership in Postgres is **not** a per-role attribute
— there is no `pg_roles` column meaning "this role owns something." Ownership is per-relation
(`pg_class.relowner`), so the original check silently let the owner case pass through
uninspected. Fixed below by adding a fourth, genuinely relation-aware check (3b) rather than
widening the role-level query, which cannot express it.

Four independent enforcements, layered rather than relying on any single one:

1. **Compile-time (static, no network — `apply`).** `compiler/src/validate.ts` parses the
   declared `query` text (after stripping leading whitespace/comments) and refuses to compile
   unless it begins with `SELECT` or `WITH … SELECT` (a read-only CTE). This is the
   `statementKind` declaration checked against the query's own shape — an author cannot declare
   `statementKind: select` and write an `UPDATE`.
2. **Transaction-level (structural, every invocation — D-4).** `SET TRANSACTION READ ONLY` makes
   Postgres itself reject any write statement that reaches the database regardless of what the
   query text says, defeating comment obfuscation or multi-statement smuggling the static check
   might miss.
3. **Role-level, superuser/BYPASSRLS (live, at `archstone verify` and at `serve`/`serve --http`
   startup — never at `apply`, which is offline).** On first connection per DSN, run
   `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`. If either is
   `true`, refuse — fail closed, loudly, naming the exact violated property
   ("connection for '<dsn-env-var>' uses a role with `rolbypassrls = true`; the runtime role must
   not bypass row-level security — see the topology guide") and refuse to serve or to verify any
   `sql`-bound capability on that connection. This is a live check and therefore cannot run at
   `apply` — `apply` never dials any backend today (REST or SQL) and stays offline, consistent
   with ADR-0005's "the compile-and-run path never requires a network call *to Archstone*,"
   which is a different claim from "a deployed server never calls the customer's own backend"
   and is not in tension with it: `serve` already calls the customer's REST backend on every
   real invocation; a one-time role check against the customer's own database at that same
   surface's startup is the same category of call, not a new dependency on Archstone.
4. **Relation-level, ownership (live, same entry points as 3 — `archstone verify` and
   `serve`/`serve --http` startup, never `apply`).** Ownership cannot be checked against
   `pg_roles`; it has to be checked against `pg_class` for specific relations, and the question
   this design needs answered is not "does this role own anything in the database" (true of
   almost every real Postgres instance, for objects the runtime role never touches) but "does
   this role own anything **it can also read**" — which is exactly the set of relations a bound
   `sql` capability could actually reach, without parsing any query text to find out. That set is
   already recorded by Postgres itself, as the connecting role's own grants:

   ```sql
   SELECT n.nspname AS schema_name, c.relname AS relation_name
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')  -- table, view, matview, partitioned table, foreign table
     AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (
       SELECT 1 FROM information_schema.role_table_grants g
       WHERE g.grantee IN (current_user, 'PUBLIC')
         AND g.table_schema = n.nspname
         AND g.table_name = c.relname
     );
   ```

   Any row returned is a refusal, naming the exact relation
   ("connection for '<dsn-env-var>' owns `<schema>.<relation>`, which it also holds a grant on —
   the runtime role must not own any relation it can query — see the topology guide"). This is
   **fully general with respect to what the connection can do**, not merely to what `init`
   introspected or to a schema an author happened to declare: a role can only ever reach a
   relation through a grant, so "every relation this role owns AND has a grant on" is exactly
   the reachable-and-owned set, with no dependency on reading, parsing, or trusting any specific
   binding's `query` text. It requires no new binding field and no author input.

   **What this does not catch, stated plainly:** `information_schema.role_table_grants` reports
   grants visible to the connecting role's own session — direct grants, `PUBLIC` grants, and
   grants reachable through role membership the connecting role has at query time — the same
   visibility Postgres itself uses to decide what the role can do. It does not, and cannot,
   catch a grant that exists but is not yet visible in this session (e.g. `NOINHERIT` role
   membership the connection has not `SET ROLE`'d into) or ownership of a relation the role could
   reach only through a mechanism outside ordinary `SELECT` grants (e.g. a `SECURITY DEFINER`
   function chain). Those are named residual gaps, not silently assumed away — see R-7.

There is no flag to bypass any of the four. All four are named explicitly so a future
contributor does not "simplify" the design down to whichever ones they find first — in
particular, checks 3 and 4 answer two different questions ("is this role inherently too
powerful" vs. "does this specific role/grant combination let it read something it owns") and
neither one is a substitute for the other.

### D-10. `archstone init`'s Postgres adapter — compile-and-probe loop, not a one-shot generator

Follows the precedent internal ADD-37 already established for the OpenAPI adapter, and reuses
its machinery rather than duplicating it:

- **A new `SourceAdapter` under `packages/init/src/adapters/postgres/`.** Unlike the OpenAPI
  adapter (a pure, static document parse), this adapter is inherently *live*: it reads
  `information_schema.tables`/`information_schema.columns`/`information_schema.views` over a
  real, read-only connection using the runtime role — so `init` can only ever propose what the
  runtime role can already `SELECT`, which is precisely what makes the curated-view topology the
  path of least resistance rather than a lecture (the product brief's journey 5.1).
- **Reuses `invokeConnector`/`invokeSql` (D-6), not a bespoke ad-hoc `pg` client inside
  `packages/init`.** The adapter issues its `information_schema` queries through the same
  dispatch function `verify` uses, over a synthetic, ephemeral `IRTool`-shaped query — never a
  second, parallel connection/session/role-check implementation. This means D-9's over-privileged
  check runs for `init`'s own introspection connection for free: pointing `init` at a superuser
  DSN refuses immediately, consistently with everywhere else.
- **Column → CDL semantic type**, from `information_schema.columns` ground truth (`is_nullable`,
  `data_type`) rather than a spec's possibly-stale declaration — actually *more* reliable than
  the OpenAPI adapter's declared/observed distinction, since this is the catalog itself. Required
  vs. optional is `is_nullable = 'NO'` directly, no probing needed. **Named gap, not built
  around:** Postgres `boolean`/`json`/`jsonb`/array column types have no faithful `SemanticType`
  in `cdl.schema.json`'s closed set (`location`, `date-range`, `party`, `preference-set`,
  `money`, `identifier`, `string`, `text`, `time-slot`, `quantity`, `enum`, `date`, `datetime` —
  no boolean, no raw JSON). Per-column skip-and-report with a new reason code
  (`column-type-not-expressible`), mirroring ADD-37's own precedent for an unmappable OpenAPI
  construct (`field-path-not-expressible`) — a tool limitation, not a CDL gap, and not proposed
  as a new semantic type here.
- **`effect` is always `read`** (v1 is read-only by construction) but is still routed through the
  same human-confirmed Decision Record ADD-37 D-3/D-4 established, for one-mental-model
  consistency across adapters rather than a special case.
- **The probe leg extends `recordContract`, and a SQL capability is never proposed with a
  contract but no isolation test.** When `init` offers to record a fixture for a proposed SQL
  capability, it also prompts for (or, non-interactively, requires) a second identity to record
  as `negativeIdentity` (D-8) in the same step. If the negative probe cannot be attempted — no
  second identity available, non-interactive mode with none supplied — `init` records **no**
  `contract:` for that capability at all (extending the existing "contract is all-or-nothing,"
  ADD-37 Challenge 2 item 3, rather than emitting a testable-looking contract with no isolation
  proof).
- **Loop structure is identical to the OpenAPI adapter's**: temp-dir materialize → `load` →
  `validateSemantics` → `compile` → `new Registry()` (tool-name collision refusal, ADD-30) →
  record-and-verify-green-before-commit → write only on success. "Adding an adapter must touch no
  file outside `adapters/`" (ADD-37 D-1) holds here more cleanly than it did for OpenAPI — there
  is no multi-document `$ref`-closure problem — **provided `providers/sql`/`invokeConnector`
  (D-1–D-6 of this ADR) land first**; this adapter is a downstream consumer of this ADR's core
  work, not a parallel effort.

---

## IR & Schema Impact — summary

| Artifact | Change | Additive? |
|---|---|---|
| `connector.schema.json` | `sql` object (`engine`, `dsn`, `statementKind`, `query`, `params`); `graphql`/`grpc`/`soap` untouched | Yes |
| `compiler/src/ir.ts` | `IRSqlConnector`; `IRConnector.sql?` | Yes — `IR.version` stays `"0"` |
| `compiler/src/validate.ts` | New error `connector-type-not-implemented` for `graphql`/`grpc`/`soap`; new checks for `sql.query`/`params` consistency and `statementKind` vs. leading keyword | Yes (new diagnostics only) |
| `response.schema.json`, `contract.schema.json`, `IRContract`, `IRResponseMapping` | **Unchanged** | n/a |
| `GoldenFixture` (TS interface, unschema'd) | `negativeIdentity?: { principal: string }` | Yes |
| `@archstone/emitter-support` root (`CallerContext`, base `InvokeOptions`) | Relocated from `providers/rest`; `identityAdapter?` added to the base | Additive; `providers/rest` re-exports the type for compatibility |
| `@archstone/emitter-support/connector` (new subpath) | `invokeConnector(tool, input, opts)` | New surface, pure root untouched |
| `providers/sql` (new package) | `invokeSql`, mirroring `invokeRest`'s `InvokeResult` shape | New package |
| `packages/init/src/adapters/postgres/` (new) | Postgres `SourceAdapter` | New, downstream of the above |

No change to `cdl.schema.json` — capabilities remain implementation-blind by construction; every
change above is binding/provider/IR-side.

---

## Consequences

**Accepted:**

- A capability bound to `sql` is, from the model's side, indistinguishable from one bound to
  `rest` — same tool listing, same input/output schema, same violation semantics — because both
  terminate in the same `applyResponseMapping`/`IRResponseMapping` machinery, and both are
  reached through the same `invokeConnector` dispatch.
- The isolation guarantee is enforced four times independently (compile-time statement check,
  transaction-level `READ ONLY`, live superuser/`BYPASSRLS` role check, live relation-ownership
  check) and is *provable*, not merely documented — `archstone verify`'s negative test is a build
  gate, not a runbook instruction.
- `CallerContext` moving to `@archstone/emitter-support` pays down debt internal ADD-32 R-1
  explicitly deferred rather than adding a second copy of caller-context plumbing beside it.
- The SQL provider adds exactly one new IR field (`IRConnector.sql`) and reuses every other IR
  concept (`IRResponseMapping`, `IRContract`, `IRField`) unmodified — the compiler's target
  neutrality is undisturbed.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A portable multi-engine `sql` connector (Postgres + Snowflake + BigQuery) in v1 | Each engine's isolation mechanism is structurally different (RLS+GUC vs. row-access-policies vs. authorized views with no per-request session concept); a shared abstraction degrades to the weakest engine's guarantee while presenting one promise (product brief Challenge 2) |
| Identity carried as a query parameter (`WHERE tenant_id = $1` bound from `caller.tenantId`) | Puts the isolation boundary back in binding-authored text — exactly what "the YAML author is not part of the security boundary" forbids. A forgotten predicate would leak; the session-GUC/RLS design makes the predicate irrelevant to correctness |
| `${caller.NAME}`-style templating inside `sql.query`, symmetric with REST's header/body templating | Reintroduces string-built SQL text at the one place it must never exist; REST's templating is safe because it only ever changes *where a request goes or what it carries*, never *what a database executes* |
| Dispatch logic duplicated in each of the four invocation call sites | The exact defect class internal ADD-30 already found and fixed once (two independently-buggy hand-rolled indexes); centralizing in one new subpath costs one file |
| Putting `invokeConnector` in `@archstone/emitter-support`'s pure root | Breaks that package's own "IR-only: no MCP SDK, no fs, no HTTP" contract for every existing pure consumer; the subpath precedent (ADD-37 R-2) solves this for free |
| RLS/GUC session state as an explicit binding-authored `SET LOCAL` statement, symmetric with the declared query | Reopens exactly the "manifest author is part of the security boundary" problem this design exists to close — a binding author could omit or mis-author the `SET`, and nothing would catch it |

---

## Risks

| ID | Risk | Likelihood | Impact | Mitigation direction |
|---|---|---|---|---|
| R-1 | A future contributor "simplifies" read-only enforcement down to one layer (e.g. drops `SET TRANSACTION READ ONLY` as "redundant" with the static check) | M | H | D-9 names all three explicitly and independently; code review treats removing any one as a Challenge trigger, same discipline ADD-42 R-11 uses for its own load-bearing line |
| R-2 | A DBA-authored RLS policy defaults to permissive when the session GUC is unset, silently widening the boundary if `identityAdapter` is ever accidentally left unconfigured | M | H | D-3's fail-closed-on-absent-identity gate means an unconfigured adapter refuses every `sql` invocation rather than running with no GUC set — the two failure modes must both hold, and are documented together in the topology guide (a docs follow-up, not code) |
| R-3 | The negative-isolation fixture format (`negativeIdentity`, unschema'd) drifts from what `verify` expects, the same class of risk ADD-37 already named for the golden-fixture format generally | M | M | Pin with a round-trip test (record → `runVerify` → red-without/green-with, per D-8); schema question deferred exactly as ADD-37 O-11 deferred it for the base fixture |
| R-4 | Postgres native-type → JSON coercion (bigint, numeric, timestamp, uuid) disagrees between what `init` observes at probe time and what a later driver version produces, causing a false drift signal | M | M | Pin the driver's type-parser configuration explicitly (no reliance on ambient defaults) as part of `providers/sql`'s own test suite, not left to each deployer's `pg` version |
| R-5 | `init`'s Postgres adapter ships before `providers/sql`/`invokeConnector` (D-1–D-6), forcing it to open its own ad-hoc connection and duplicating the exact mechanism this ADR centralizes | L (sequencing is stated) | H | D-10 states the dependency order explicitly; implementation guidance below sequences accordingly |
| R-6 | Premature Phase-2 (edge/Hyperdrive) complexity creeps into v1 because "it would be nice to also run this on Workers" | L | M | D-5 draws the exclusion boundary now and builds no accommodation for it; a data-proxy decision is explicitly deferred to a real customer demand, per the product brief |
| R-7 | The ownership check (D-9, layer 4) misses a grant the connecting role holds but that is not visible in the checking session — most plausibly a `NOINHERIT` role membership the connection has not `SET ROLE`'d into, or a path to data reached through a `SECURITY DEFINER` function rather than a direct table/view grant | L | H | Named explicitly in D-9 rather than folded into a general "best effort" disclaimer, so the topology guide can say precisely what is and is not covered. The mitigation is operational, not code: the documented default topology (a runtime role granted directly on a curated view schema, no role-membership indirection, no `SECURITY DEFINER` in the exposed surface) is exactly the shape under which this check is complete, and `archstone init`'s own output never produces the shape that would evade it |

---

## Open Questions

1. **Verify-time identity source.** D-8 assumes an operator/CI-configured "verify identity" the
   positive replay runs under, resolved through the same `identityAdapter`. This needs a concrete
   CLI/CI wiring (an env var? a `--verify-caller` flag?) that this ADR has not fully specified —
   left for the implementation issue, since it does not affect the IR/schema/dispatch design
   above. Confirmed as genuinely open, not a gap in this ADR: whichever wiring is chosen, D-8's
   fourth case (negative identity present but unresolved ⇒ 🔴, same as absent) already fixes the
   *behavior* independent of *how* the identity is supplied, so the BA's acceptance criteria can
   be written against that behavior now without waiting on this question.
2. **`archstone init`'s scaffolded RLS/view SQL.** The product brief's journey 5.1 has `init`
   "refusing to propose anything the runtime role cannot select," which this ADR covers, but does
   not propose `init` *generating* the curated-view/RLS migration SQL itself — that remains a
   human/DBA authoring step. Worth a follow-up product decision once v1 ships and real DBAs have
   used it.
3. **Pool-sizing defaults and observability.** D-5 defers connection-pool sizing to deployer
   configuration with no product surface; whether `archstone verify --json`/a future console
   evidence pack should also report pool-exhaustion incidents is out of scope here and flagged
   for the console-side follow-up the product brief already names as explicitly deferred.

---

## Implementation Guidance (ordered)

1. **`@archstone/emitter-support`**: relocate `CallerContext` and the connector-agnostic half of
   `InvokeOptions`; add `identityAdapter?`; `providers/rest` re-exports the type. New
   `@archstone/emitter-support/connector` subpath housing `invokeConnector` — stubbed to call
   `invokeRest` only, for now, so this step is independently shippable and non-breaking.
2. **`connector.schema.json` + `compiler/src/ir.ts`/`compile.ts`/`validate.ts`**: add the `sql`
   object, `IRSqlConnector`, the query/params/statementKind static checks, and the
   `connector-type-not-implemented` diagnostic for `graphql`/`grpc`/`soap`.
3. **`providers/sql`** (new package): `invokeSql`, the transaction/session mechanics (D-4), the
   role-privilege check (D-9 layer 3), pool lifecycle (D-5). Wire into `invokeConnector`.
4. **`runtime/src/verify.ts`**: route `verifyTool`/`recordContract` through `invokeConnector`;
   implement the negative-isolation replay (D-8) for `sql` connectors.
5. **`agent/src/execute.ts`, `runtime/src/server.ts`**: route `executeCapability`/`callTool`
   through `invokeConnector`.
6. **`packages/init/src/adapters/postgres/`**: build only after steps 1–4 land, per D-10/R-5.
7. **Docs**: the topology guide (curated-view default, RLS-on-base-tables alternative, the
   fail-closed role check's exact error text) — a tech-writer follow-up once the mechanism above
   is implemented, not before.
