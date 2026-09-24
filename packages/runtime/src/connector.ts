// @archstone/runtime/connector — the FULL (Node-only) connector dispatch (ADR-0012 D-6)
//
// Adds `sql` support on top of `./connector-rest`'s edge-safe dispatch, by importing
// `@archstone/provider-sql` — which imports `pg`, a Node-only package. THIS FILE MUST NEVER BE
// IMPORTED BY `runtime/src/server.ts`, `runtime/src/http.ts`, or `agent/src/execute.ts` — those
// default to `./connector-rest` and accept this dispatcher only as an explicit, Node-only-caller
// -supplied `connector` override. `packages/runtime/test/boundary.test.ts` and
// `packages/agent/test/boundary.test.ts` pin exactly this.
//
// Reachable only from: `runtime/src/verify.ts` (already fs-based, Node-only, never imported
// from the edge-safe `/http` subpath), and `@archstone/cli` (a Node binary), which injects this
// as the `connector` override for `serveStdio` (D-5 explicitly lists stdio — "one child process
// per conversation" — as a `sql`-supporting surface, unlike the `/http` subpath).
//
// Before this file existed, four call sites (`executeCapability` in @archstone/agent, `callTool`
// in runtime/src/server.ts, `verifyTool`/`recordContract` in runtime/src/verify.ts) each imported
// `invokeRest` directly and called it unconditionally. Centralizing dispatch here (rather than
// teaching four places to branch on `tool.connector?.type` independently) is the same
// duplicated-mechanism defect class internal ADD-30 already found and fixed once for tool-name
// resolution — `no call site branches on tool.connector?.type itself` is the property this file
// (layered on `./connector-rest`) preserves; `server.ts`/`execute.ts` still centralize on
// `./connector-rest`'s single default, they simply default to a NARROWER dispatcher than
// `verify.ts`/the CLI's stdio path do.
//
// Placed under `@archstone/runtime` rather than `@archstone/emitter-support` (the ADR's own
// sketch): `emitter-support` is a dependency of BOTH `providers/rest` and `providers/sql`
// (for the shared `CallerContext`/`InvokeOptions` base, ADR-0012 D-3) — a subpath there that
// itself imported those two providers back would be a circular WORKSPACE dependency, not merely
// a circular module graph, and would make `pnpm -r build`'s topological order unsatisfiable.
// `@archstone/runtime` sits strictly above both providers already (it depends on
// `@archstone/provider-rest` today) and is already a transitive dependency of every consumer
// that needs this dispatch (`@archstone/agent` depends on `@archstone/runtime`; `@archstone/cli`
// and `@archstone/init` both depend on `@archstone/runtime`) — so this subpath adds no new
// package edge anywhere, only a new FILE.

import type { IRTool } from "@archstone/compiler";
import type { InvokeOptions as RestInvokeOptions, InvokeResult } from "@archstone/provider-rest";
import { invokeSql, type SqlInvokeOptions } from "@archstone/provider-sql";
import { dispatchRest } from "./connector-rest";

export type { InvokeResult } from "@archstone/provider-rest";

/** The union every Node-only caller of this FULL dispatcher passes — a superset of both
 *  providers' own options, since a manifest may bind some capabilities to `rest` and others to
 *  `sql`. Also the type every EDGE-SAFE consumer's options bag widens to (type-only — carrying
 *  `identityAdapter`/`pgPoolFactory` as a TYPE costs nothing at runtime; erased entirely by
 *  `import type`), so a deployer keeps ONE options object regardless of which dispatcher a given
 *  surface ends up using. */
export type ConnectorInvokeOptions = RestInvokeOptions & SqlInvokeOptions;

/**
 * Dispatch one invocation to `rest` OR `sql`. `rest`/unimplemented/absent-connector are
 * delegated to `./connector-rest`'s PURE `dispatchRest` — a single source of truth for that
 * half, never duplicated here, and deliberately NOT the override-checking `invokeConnectorRest`:
 * this function IS itself the override a Node-only caller supplies (e.g. `@archstone/cli`
 * injects `invokeConnector` as `serveStdio`'s `connector` option), and re-entering the
 * override-check would recurse forever whenever `opts.connector` points back at this function.
 */
export async function invokeConnector(
  tool: IRTool,
  input: Record<string, unknown>,
  opts: ConnectorInvokeOptions = {},
): Promise<InvokeResult> {
  if (tool.connector?.type === "sql") return invokeSql(tool, input, opts);
  return dispatchRest(tool, input, opts);
}
