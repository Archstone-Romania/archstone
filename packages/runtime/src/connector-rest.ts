// @archstone/runtime/connector-rest — the EDGE-SAFE connector dispatch (ADR-0012 D-5/D-6)
//
// This file imports ONLY `@archstone/provider-rest` — a `fetch`-based, edge-compatible
// package. It never imports `@archstone/provider-sql` (which pulls in `pg`, a Node-only
// package that does `require("net")`/`require("tls")`/`require("dns")` at module load time,
// not lazily — confirmed to grow the `examples/demo/remote-mcp-worker` Cloudflare Workers
// bundle by ~200 KiB when reachable).
//
// This is the DEFAULT dispatcher for every consumer that must stay edge-safe by construction
// (ADD-0008 #27/#28's "pure mapper + fetch + injectable env only" surface):
//   - `runtime/src/server.ts` (`callTool`/`createMcpServer`) — shared by `serveStdio` (stdio,
//     Node-only) AND `runtime/src/http.ts` (the edge-safe `/http` subpath, D-5) AND
//     `examples/demo/remote-mcp-worker` (imports the package ROOT directly). It must default to
//     THIS dispatcher, never the full one, so none of its three consumers gains a static edge
//     to `pg` merely by existing.
//   - `@archstone/agent`'s `execute()` (RFC-0008's embedded, edge-deployable surface).
//
// A Node-only caller that wants `sql`-bound capabilities to actually work — `archstone serve`
// (stdio), `archstone verify`, or a Node embedder of `@archstone/agent` who explicitly accepts
// the `pg` dependency — supplies the FULL dispatcher (`./connector`) as an explicit `connector`
// override on the shared options bag (see `server.ts`'s `callTool`/`createMcpServer` and
// `agent/src/execute.ts`). Nothing in THIS file, or in anything it imports, ever mentions
// `providers/sql`/`pg` — that is the property `packages/emitter-support/test/boundary.test.ts`'s
// sibling assertions in `packages/runtime/test/boundary.test.ts` and
// `packages/agent/test/boundary.test.ts` pin against `server.ts`/`http.ts`/`execute.ts`
// specifically (a subpath-aware check, not merely a bare-specifier one).

import type { IRTool } from "@archstone/compiler";
import { invokeRest, type InvokeOptions as RestInvokeOptions, type InvokeResult } from "@archstone/provider-rest";

export type { InvokeResult } from "@archstone/provider-rest";

/**
 * A connector-dispatch function, structurally — not tied to any specific connector's own
 * options type. This is the SHAPE a Node-only caller's `sql`-aware override
 * (`./connector`'s `invokeConnector`) satisfies; this file never imports that module, so the
 * type alone carries zero runtime cost and zero reachability to `pg`.
 */
export type ConnectorDispatch = (tool: IRTool, input: Record<string, unknown>, opts: InvokeOptions) => Promise<InvokeResult>;

export interface InvokeOptions extends RestInvokeOptions {
  /**
   * ADR-0012 D-5/D-6 — a Node-only caller's explicit opt-in to `sql`-bound-capability support.
   * Absent (the default, and the only option on a genuinely edge-deployed surface): every
   * invocation routes through `invokeConnectorRest` below, which never imports `pg`. Present
   * (set only by `@archstone/cli`'s stdio `serve` path and `runtime/src/verify.ts`, both
   * Node-only and never bundled for an edge target): every invocation routes through the
   * supplied function instead — see `./connector`'s `invokeConnector`, the one function in this
   * codebase that actually imports `@archstone/provider-sql`.
   */
  connector?: ConnectorDispatch;
}

/** ADR-0012 D-2/BR-9 — reserved, unimplemented connector types. `apply` already refuses these
 *  (`connector-type-not-implemented`, compiler/src/validate.ts); this is the SAME closed set,
 *  read here so a manifest that somehow reaches this dispatcher anyway (a hand-built IR, or a
 *  pre-existing manifest compiled before this check shipped) still gets a clean, consistent
 *  result instead of an opaque failure deep inside a connector that does not exist. Shared
 *  verbatim by the full dispatcher (`./connector`) — one closed set, read once. */
export const UNIMPLEMENTED_CONNECTOR_TYPES: ReadonlySet<string> = new Set(["graphql", "grpc", "soap"]);

/**
 * The PURE rest/unimplemented/absent-connector logic, with no `opts.connector` override check —
 * exported so `./connector` (the full, Node-only dispatcher) can reuse it verbatim for its own
 * non-`sql` cases without re-triggering the override check below (which would otherwise recurse
 * forever if a caller's `opts.connector` happened to point at that very dispatcher).
 */
export async function dispatchRest(tool: IRTool, input: Record<string, unknown>, opts: InvokeOptions = {}): Promise<InvokeResult> {
  const type = tool.connector?.type;
  if (type === "rest") return invokeRest(tool, input, opts);
  if (type === "sql") {
    return {
      ok: false,
      status: 0,
      error: `capability '${tool.id}': connector type 'sql' is not available on this edge-safe surface — sql-bound capabilities require a Node-only dispatcher (archstone serve, archstone verify, or an explicit connector override)`,
    };
  }
  if (type !== undefined && UNIMPLEMENTED_CONNECTOR_TYPES.has(type)) {
    return { ok: false, status: 0, error: `capability '${tool.id}': connector type '${type}' is not implemented` };
  }
  return { ok: false, status: 0, error: `capability '${tool.id}' has no connector` };
}

/**
 * The public entry point `server.ts`/`http.ts`/`execute.ts` call. If `opts.connector` is set (a
 * Node-only caller's explicit override), delegate to it unconditionally — this is the ONE place
 * that decision is made, so no consumer needs its own `opts.connector ?? …` branch. Absent an
 * override (the only possibility on a genuinely edge-deployed surface), falls through to the
 * pure `dispatchRest` above.
 */
export async function invokeConnectorRest(tool: IRTool, input: Record<string, unknown>, opts: InvokeOptions = {}): Promise<InvokeResult> {
  if (opts.connector) return opts.connector(tool, input, opts);
  return dispatchRest(tool, input, opts);
}
