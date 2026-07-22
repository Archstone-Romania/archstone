// @archstone/agent — the embedded SDK (RFC-0008 / ADD-0008 #28)
//
// Root entry ONLY: fromIR, tools(format), execute(). Zero @modelcontextprotocol/sdk
// reachability from this entry's module graph — the `/mcp` subpath (mcpHandler, #29,
// out of scope here) is the only place this package reaches the MCP SDK, transitively via
// @archstone/runtime's `/http` subpath. Dependencies: @archstone/compiler (types),
// @archstone/emitter-support, @archstone/provider-rest — no @archstone/runtime, no MCP SDK,
// no node:fs/node:path (see test/boundary.test.ts).

import type { IR } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import { buildToolDefs, type ToolFormat, type ToolDef } from "./tools";
import { executeCapability, type ExecuteOptions, type ExecuteResult } from "./execute";

export type {
  ToolFormat,
  ToolDef,
  AnthropicToolDef,
  OpenAIToolDef,
  GeminiToolDef,
  JsonSchemaToolDef,
} from "./tools";
export { sanitizeGeminiSchema } from "./tools";
export type { ExecuteOptions, ExecuteResult } from "./execute";
export type { FetchLike } from "@archstone/provider-rest";
export { Registry } from "@archstone/emitter-support";

/** Thrown by fromIR() when the artifact isn't a `version: "0"` IR — D-2's one enforced
 *  public contract surface (ADD-0008 §3). Fail-closed: missing, wrong-typed, or a future
 *  version all throw rather than proceeding on a shape this package doesn't recognize. */
export class InvalidArtifactError extends Error {
  constructor(reason: string) {
    super(`invalid archstone IR artifact: ${reason}`);
    this.name = "InvalidArtifactError";
  }
}

/** The embedded SDK object returned by fromIR() — wraps a Registry over the compiled IR. */
export interface Archstone {
  readonly registry: Registry;
  tools(format: ToolFormat): ToolDef[];
  execute(capabilityId: string, input: Record<string, unknown>, opts?: ExecuteOptions): Promise<ExecuteResult>;
}

/**
 * Construct an embedded Archstone instance from a compiled IR artifact (produced by
 * `archstone build`, ADD-0008 #27). Fail-closed: only `version` is validated before the
 * artifact is trusted — the rest of the shape is treated as opaque/trusted once that check
 * passes (D-2: the IR is not a documented public contract).
 */
export function fromIR(json: unknown): Archstone {
  if (typeof json !== "object" || json === null) {
    throw new InvalidArtifactError("expected an object");
  }
  const version = (json as { version?: unknown }).version;
  if (version !== "0") {
    throw new InvalidArtifactError(`unsupported version ${JSON.stringify(version)} (expected "0")`);
  }

  const registry = new Registry(json as IR);
  // ADD-30 D-2: refuse before `tools()`/`execute()` are ever reachable — a tool-name
  // collision would otherwise let `execute()` silently resolve a shared advertised name to
  // whichever colliding capability the registry happened to index first (BR-6).
  if (registry.toolNameCollisions.length > 0) {
    const detail = registry.toolNameCollisions.map((c) => `'${c.name}' (${c.ids.join(", ")})`).join("; ");
    throw new InvalidArtifactError(`ambiguous tool name(s): ${detail}`);
  }

  return {
    registry,
    tools: (format) => buildToolDefs(registry, format),
    execute: (capabilityId, input, opts) => executeCapability(registry, capabilityId, input, opts),
  };
}
