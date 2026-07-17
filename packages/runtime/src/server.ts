// @archstone/runtime — MCP server construction (fs-free)
//
// Builds an MCP Server from a Registry and routes invocations through the REST provider
// (#6). This is the ONLY place the MCP SDK appears (alongside stdio's transport wiring in
// mcp.ts and the /http subpath's transport wiring in http.ts) — semantic-type → JSON-Schema
// lowering itself now lives in @archstone/emitter-support (ADD-0008 #27), never here.
//
// Extracted out of mcp.ts (ADD-0008 #27) specifically so this module's graph never reaches
// registry.ts's buildRegistry/@archstone/schema `load()` (the fs edge) — only stdio's
// `serveStdio` (mcp.ts) needs disk access. `http.ts` (the /http subpath) imports only this
// file, so a consumer depending on that subpath alone stays fs-free.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IRTool } from "@archstone/compiler";
import { Registry, inputJsonSchema, objectJsonSchema, toolName, applyResponseMapping } from "@archstone/emitter-support";
import { invokeRest, type InvokeOptions } from "@archstone/provider-rest";

type JsonSchema = Record<string, unknown>;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

/**
 * Index of emitted tools by their sanitized MCP name. Only invocable (bound)
 * capabilities are emitted, so an unbound capability's name is absent here — the
 * single source of truth shared by `toolDefinitions` (what's listed) and
 * `callTool` (what's resolvable), keeping the two consistent.
 */
function emittedTools(registry: Registry): Map<string, IRTool> {
  const byName = new Map<string, IRTool>();
  for (const t of registry.listCapabilities()) {
    if (t.connector) byName.set(toolName(t.id), t);
  }
  return byName;
}

/** The MCP tool list: only invocable (bound) capabilities become tools. Input and output
 *  fields lower against the IR resource registry, so a `collection: Stay` output emits a
 *  typed, described `outputSchema` (not a bare `{type:object}`). */
export function toolDefinitions(registry: Registry): McpToolDef[] {
  const resources = registry.ir.resources;
  return [...emittedTools(registry)].map(([name, t]) => {
    const def: McpToolDef = {
      name,
      description: t.description,
      inputSchema: inputJsonSchema(t.input, resources),
    };
    if (t.output.length > 0) def.outputSchema = objectJsonSchema(t.output, resources);
    return def;
  });
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

/** #19 ADD-19 Rev 2 D-6: the namespaced `_meta` key a VIOLATION result's structured error
 *  object is carried under. Never populated on `structuredContent` (D-3′) — the reference
 *  MCP SDK client validates `structuredContent` against `outputSchema` whenever the tool
 *  declares one, regardless of `isError`, so a non-conforming error object there crashes the
 *  client. `_meta` is untouched by that validation and passes through the client's zod parse
 *  unstripped (`ResultSchema`/`RequestMetaSchema` are `z.looseObject`). */
export const CONTRACT_VIOLATION_META_KEY = "dev.archstone/contract_violation";

/** Route an MCP tool call to the REST provider and format the result as MCP content. */
export async function callTool(
  registry: Registry,
  name: string,
  args: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<CallResult> {
  const tool = emittedTools(registry).get(name);
  if (!tool) {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  const result = await invokeRest(tool, args, opts);
  if (!result.ok) {
    return { content: [{ type: "text", text: result.error ?? "invocation failed" }], isError: true };
  }

  // #12 (ADD-12): a binding with a `response:` mapping is now MAPPED + VALIDATED against the
  // resource — the outputSchema (ADD-11) becomes an enforced contract, not just declared.
  if (tool.response) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      // Fail closed (D-6): the declared output shape was not met — no raw pass-through.
      const missing = mapped.missing ?? [];
      const text = `contract violation: capability '${tool.id}' — provider response is missing required field(s): ${missing.join(", ")}. Declared output shape not met; raw body withheld.`;
      // #19 (ADD-19 Rev 2 D-3′/D-6): structured error object lives in `_meta`, never
      // `structuredContent` — the reference SDK client validates `structuredContent` against
      // the tool's `outputSchema` unconditionally (not gated on `isError`), so a VIOLATION
      // object there (which never conforms to the success outputSchema) crashes the client
      // (verified live against the SDK's own InMemoryTransport, R2.0/R2.2). `capability` is
      // `tool.id`, the unsanitized CDL id — never the MCP-sanitized `name` lookup key (BR-7).
      return {
        content: [{ type: "text", text }],
        _meta: { [CONTRACT_VIOLATION_META_KEY]: { error: "contract_violation", capability: tool.id, missing } },
        isError: true,
      };
    }
    const content: CallResult["content"] = [{ type: "text", text: JSON.stringify(mapped.data, null, 2) }];
    if (mapped.status === "degraded") {
      content.push({ type: "text", text: `note: optional field(s) absent (degraded): ${(mapped.degraded ?? []).join(", ")}` });
    }
    return { content, structuredContent: mapped.data, isError: false };
  }

  // No response mapping: today's raw pass-through (rollout-safe). The declared outputSchema is
  // NOT yet enforced for these tools — add a `response:` block to close the loop (ADD-12 R-3).
  const out: CallResult = { content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }], isError: false };
  if (tool.output.length > 0) {
    const data = result.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      out.structuredContent = data as Record<string, unknown>;
    }
  }
  return out;
}

/** Build an MCP Server that lists and invokes the registry's tools. */
export function createMcpServer(registry: Registry, opts?: InvokeOptions): Server {
  const server = new Server({ name: "archstone", version: "0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(registry) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(registry, req.params.name, args, opts);
    return result as CallToolResult;
  });

  return server;
}
