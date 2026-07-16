// @archstone/runtime — MCP emitter (#7)
//
// Emits IR tools as MCP tools over stdio and routes invocations through the REST
// provider (#6). This is the ONLY place the MCP SDK appears, and the ONLY place
// semantic types are lowered to JSON Schema (deferred here from #4 per ADD-04).
// The IR/compiler never see MCP or JSON Schema.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IRField, IRResourceRegistry, IRTool, SemanticType } from "@archstone/compiler";
import { invokeRest, type InvokeOptions } from "@archstone/provider-rest";
import { buildRegistry, Registry } from "./registry";
import { applyResponseMapping } from "./mapping";

type JsonSchema = Record<string, unknown>;

/** MCP tool names are stricter than capability ids — sanitize `tourism.search` → `tourism_search`. */
export function toolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

function semanticJsonSchema(semantic: SemanticType, values?: string[]): JsonSchema {
  switch (semantic) {
    case "location":
      return { type: "string", description: "A place — city, region, or address." };
    case "date-range":
      return {
        type: "object",
        properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } },
        required: ["from", "to"],
      };
    case "party":
      return {
        type: "object",
        properties: { adults: { type: "integer" }, children: { type: "integer" } },
        required: ["adults"],
      };
    case "preference-set":
      return { type: "array", items: { type: "string" } };
    case "money":
      return {
        type: "object",
        properties: { amount: { type: "number" }, currency: { type: "string" } },
        required: ["amount", "currency"],
      };
    case "time-slot":
    case "datetime":
      return { type: "string", format: "date-time" };
    case "date":
      return { type: "string", format: "date" };
    case "quantity":
      return { type: "number" };
    case "enum":
      return { type: "string", enum: values ?? [] };
    case "identifier":
    case "string":
    case "text":
    default:
      return { type: "string" };
  }
}

/**
 * Lower a resolved resource (looked up by canonical name in the registry) to a typed,
 * described object schema. `visited` guards against recursive/self-referential resources
 * (R-3): a name already being expanded stops at a generic `{type:object}`. An unknown name
 * (validation floor) also degrades to `{type:object}` rather than crashing.
 */
function resourceJsonSchema(name: string, resources: IRResourceRegistry, visited: ReadonlySet<string>): JsonSchema {
  const fields = resources[name];
  if (!fields || visited.has(name)) return { type: "object" };
  const next = new Set(visited).add(name);
  return objectJsonSchema(fields, resources, next);
}

function fieldJsonSchema(f: IRField, resources: IRResourceRegistry, visited: ReadonlySet<string>): JsonSchema {
  const base: JsonSchema = f.description ? { description: f.description } : {};
  if (f.type.kind === "collection") return { ...base, type: "array", items: resourceJsonSchema(f.type.of, resources, visited) };
  if (f.type.kind === "resource") return { ...base, ...resourceJsonSchema(f.type.name, resources, visited) };
  return { ...base, ...semanticJsonSchema(f.type.semantic, f.type.values) };
}

/** Lower an IR field list to a JSON Schema object, resolving resource/collection field
 *  types through the registry (typed, described). Used for both input and output schemas. */
export function objectJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}, visited: ReadonlySet<string> = new Set()): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldJsonSchema(f, resources, visited);
    if (f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Lower IR input fields to a JSON Schema object (the tool's inputSchema). */
export function inputJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}): JsonSchema {
  return objectJsonSchema(fields, resources);
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
}

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
      const text = `contract violation: provider response is missing required field(s): ${(mapped.missing ?? []).join(", ")}. Declared output shape not met; raw body withheld.`;
      return { content: [{ type: "text", text }], isError: true };
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

/** Build the registry from a manifest dir and serve it over stdio (blocks). */
export async function serveStdio(dir: string): Promise<void> {
  const built = buildRegistry(dir);
  if (!built.ok || !built.registry) {
    // stdout is the MCP channel — all human output goes to stderr.
    console.error(`archstone: cannot serve '${dir}' — manifest invalid:`);
    for (const i of built.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of built.diagnostics.filter((x) => x.severity === "error")) console.error(`  - ${d.message}`);
    process.exit(1);
  }
  const tools = toolDefinitions(built.registry);
  console.error(`archstone: serving ${tools.length} tool(s) over stdio: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  const server = createMcpServer(built.registry);
  await server.connect(new StdioServerTransport());
}
