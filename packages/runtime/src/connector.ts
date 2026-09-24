// @archstone/runtime/connector — centralized connector dispatch (ADR-0012 D-6)
//
// Before this file, four call sites (`executeCapability` in @archstone/agent, `callTool` in
// runtime/src/server.ts, `verifyTool`/`recordContract` in runtime/src/verify.ts) each imported
// `invokeRest` directly and called it unconditionally. Adding a second connector type without
// centralizing dispatch would mean teaching four places, independently, to branch on
// `tool.connector?.type` — the exact duplicated-mechanism defect class internal ADD-30 already
// found and fixed once for tool-name resolution. `invokeConnector` is now the ONE place that
// switches on `tool.connector?.type`; no other call site does.
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
// package edge anywhere, only a new FILE. Same "a bundler can tree-shake an import, not a
// method" precedent this repo already used once for `@archstone/runtime/verify` (ADD-37 R-2):
// `src/index.ts` (the MCP-SDK-bearing root) is untouched, and neither is `src/http.ts`
// (the edge-safe subpath, D-5) — this file imports `pg`-bearing `providers/sql`, so it must
// never be reachable from there.

import type { IRTool } from "@archstone/compiler";
import { invokeRest, type InvokeOptions as RestInvokeOptions, type InvokeResult } from "@archstone/provider-rest";
import { invokeSql, type SqlInvokeOptions } from "@archstone/provider-sql";

export type { InvokeResult } from "@archstone/provider-rest";

/** The union every one of the four call sites now passes — a superset of both providers' own
 *  options, since a manifest may bind some capabilities to `rest` and others to `sql`. */
export type ConnectorInvokeOptions = RestInvokeOptions & SqlInvokeOptions;

/** ADR-0012 D-2/BR-9 — reserved, unimplemented connector types. `apply` already refuses these
 *  (`connector-type-not-implemented`, compiler/src/validate.ts); this is the SAME closed set,
 *  read here so a manifest that somehow reaches `invokeConnector` anyway (a hand-built IR, or a
 *  pre-existing manifest compiled before this check shipped) still gets a clean, consistent
 *  result instead of an opaque failure deep inside a connector that does not exist. */
const UNIMPLEMENTED_TYPES = new Set(["graphql", "grpc", "soap"]);

/**
 * Dispatch one invocation to the right connector, or return a clean, consistent failure result
 * when there is none to dispatch to. No call site should ever import `invokeRest`/`invokeSql`
 * directly, or branch on `tool.connector?.type` itself — this is the one place that does.
 */
export async function invokeConnector(
  tool: IRTool,
  input: Record<string, unknown>,
  opts: ConnectorInvokeOptions = {},
): Promise<InvokeResult> {
  const type = tool.connector?.type;
  if (type === "rest") return invokeRest(tool, input, opts);
  if (type === "sql") return invokeSql(tool, input, opts);
  if (type !== undefined && UNIMPLEMENTED_TYPES.has(type)) {
    return { ok: false, status: 0, error: `capability '${tool.id}': connector type '${type}' is not implemented` };
  }
  return { ok: false, status: 0, error: `capability '${tool.id}' has no connector` };
}
