// @archstone/runtime — Response mapper (ADD-12 / RFC-0006).
//
// Applies a tool's IRResponseMapping to a live provider body: locate the item list,
// map each item's resource fields, and validate required fields. Pure (no MCP, no HTTP,
// no I/O) so the future contract probe (#18) replays the exact same code path — one
// behaviour, tested once. Required-ness is read from the resource registry (not the
// mapping), so this can never disagree with the emitted outputSchema (ADD-11).

import { evalPath, type IRResourceRegistry, type IRTool } from "@archstone/compiler";

export type MappingStatus = "ok" | "degraded" | "violation";

export interface MappingResult {
  status: MappingStatus;
  data?: Record<string, unknown>; // { [outputField]: mappedArray | mappedObject } — matches outputSchema
  missing?: string[]; // required fields absent → VIOLATION (fail-closed, no raw fallback)
  degraded?: string[]; // optional fields absent → DEGRADED (returned, field omitted)
}

/** First JSONPath match, or undefined when the path resolves to nothing. */
function firstMatch(json: unknown, path: string): unknown {
  const matches = evalPath(json, path);
  return matches.length > 0 ? matches[0] : undefined;
}

/**
 * Map + validate a provider body against the tool's response mapping. A required field
 * (per the resource registry, unless loosened by `requiredOverride`) that resolves to
 * nothing on ANY item is a VIOLATION; an absent optional field DEGRADES. An empty
 * collection is OK (emptiness is not drift).
 */
export function applyResponseMapping(tool: IRTool, body: unknown, resources: IRResourceRegistry): MappingResult {
  const mapping = tool.response;
  if (!mapping) return { status: "ok", data: {} }; // caller guards on tool.response; defensive

  const resourceFields = resources[mapping.resource] ?? [];
  const requiredByName = new Map(resourceFields.map((f) => [f.name, f.required]));

  const items: unknown[] = mapping.collection ? evalPath(body, mapping.collection) : [body];

  const missing = new Set<string>();
  const degraded = new Set<string>();
  const mapped: Record<string, unknown>[] = [];

  for (const item of items) {
    const obj: Record<string, unknown> = {};
    for (const fm of mapping.fields) {
      const value = firstMatch(item, fm.path);
      const required = (requiredByName.get(fm.name) ?? true) && fm.requiredOverride !== false;
      if (value === undefined || value === null) {
        if (required) missing.add(fm.name);
        else degraded.add(fm.name);
        continue;
      }
      obj[fm.name] = value;
    }
    mapped.push(obj);
  }

  if (missing.size > 0) return { status: "violation", missing: [...missing] };

  const value = mapping.collection ? mapped : mapped[0];
  const data: Record<string, unknown> = { [mapping.field]: value };
  return degraded.size > 0 ? { status: "degraded", data, degraded: [...degraded] } : { status: "ok", data };
}
