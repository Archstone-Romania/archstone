// Shared builders for hand-written Draft Models.
//
// Hand-written on purpose: steps 1–4 of ADD-37 are adapter-independent, so every test here
// exercises emission, the loop and the harness against a model an adapter WOULD produce,
// without any adapter existing. When step 5's adapter lands, these same shapes become its
// conformance targets rather than being replaced.

import {
  absent,
  declared,
  observed,
  type DraftArrayNode,
  type DraftInputField,
  type DraftModel,
  type DraftNode,
  type DraftObjectNode,
  type DraftOperation,
  type DraftProperty,
  type DraftScalarNode,
  type Fact,
  type ObservedPresence,
} from "@archstone/init";
import type { SemanticType } from "@archstone/compiler";

export function scalarNode(opts: {
  type?: SemanticType;
  values?: string[];
  nullable?: boolean;
  description?: string;
  example?: unknown;
  source?: string;
  derivation?: "declared" | "observed";
}): DraftScalarNode {
  const fact = <T>(value: T | undefined, source?: string): Fact<T> =>
    value === undefined ? absent() : opts.derivation === "observed" ? observed(value, source) : declared(value, source);
  return {
    kind: "scalar",
    type: fact(opts.type, opts.source),
    ...(opts.values ? { values: opts.values } : {}),
    nullable: opts.nullable === undefined ? absent<boolean>() : fact(opts.nullable),
    description: fact(opts.description),
    example: opts.example === undefined ? absent<unknown>() : fact(opts.example, opts.source),
  };
}

export function property(
  name: string,
  node: DraftNode,
  opts: { declaredRequired?: boolean; presence?: ObservedPresence } = {},
): DraftProperty {
  return {
    name,
    declaredRequired: opts.declaredRequired === undefined ? absent<boolean>() : declared(opts.declaredRequired),
    ...(opts.presence ? { presence: opts.presence } : {}),
    node,
  };
}

export function objectNode(properties: DraftProperty[], opts: { name?: string; description?: string } = {}): DraftObjectNode {
  return {
    kind: "object",
    name: opts.name === undefined ? absent<string>() : declared(opts.name),
    description: opts.description === undefined ? absent<string>() : declared(opts.description),
    properties,
  };
}

export function arrayOf(items: DraftNode): DraftArrayNode {
  return { kind: "array", items };
}

export function inputField(
  name: string,
  where: DraftInputField["in"],
  opts: { type?: SemanticType; values?: string[]; required?: boolean; description?: string; wireName?: string; example?: unknown } = {},
): DraftInputField {
  return {
    name,
    in: where,
    ...(opts.wireName ? { wireName: opts.wireName } : {}),
    type: opts.type === undefined ? absent() : declared(opts.type),
    ...(opts.values ? { values: opts.values } : {}),
    required: opts.required === undefined ? absent<boolean>() : declared(opts.required),
    description: opts.description === undefined ? absent<string>() : declared(opts.description),
    example: opts.example === undefined ? absent<unknown>() : declared(opts.example),
  };
}

export function operation(
  method: string,
  path: string,
  opts: { description?: string; input?: DraftInputField[]; response?: DraftNode } = {},
): DraftOperation {
  return {
    key: `${method} ${path}`,
    method,
    path,
    suggestedAction: absent<string>(),
    description: opts.description === undefined ? absent<string>() : declared(opts.description),
    input: opts.input ?? [],
    response: opts.response ?? { kind: "unknown" },
    notes: [],
  };
}

export function draftModel(operations: DraftOperation[], overrides: Partial<DraftModel> = {}): DraftModel {
  return {
    version: "0",
    source: { adapter: "test", origin: "a hand-written draft" },
    company: { id: absent<string>(), name: declared("Acme Parts"), description: absent<string>() },
    baseUrl: declared("https://api.example.test"),
    operations,
    notes: [],
    ...overrides,
  };
}
