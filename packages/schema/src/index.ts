// @archstone/schema — Schema Loader (#2)
//
// Loads deployable CDL manifests from disk and validates their *shape* against
// the JSON Schemas in schemas/. Structure only — meaning (does the
// provider resolve? do declared IDs match files?) is the Semantic Validator (#3).
//
// The only capability format is CDL 0.2 (`capability:` root, cdl.schema.json),
// which keeps REST/HTTP/JSON-Schema out of the authoring surface.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

// Schema compilation touches the filesystem (schema JSON files) and `import.meta.url`.
// Deferred to first `load()` call (not module-import time) so a consumer that only needs
// OTHER exports of this module (e.g. types, or code that never calls `load()`) can be
// imported in an environment with no real filesystem — a bundler, a Workers/edge runtime —
// without crashing merely from being imported transitively.
interface Validators {
  capabilities: ValidateFunction;
  capability: ValidateFunction;
  binding: ValidateFunction;
  resource: ValidateFunction;
}

let validators: Validators | undefined;

function getValidators(): Validators {
  if (validators) return validators;

  const here = dirname(fileURLToPath(import.meta.url));
  const SCHEMAS_DIR = process.env.ARCHSTONE_SCHEMAS_DIR ?? resolve(here, "../schemas");

  function readSchema(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf8"));
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  // Env placeholders (${BOOKING_API_URL}) are valid at authoring time; real
  // URL/format checks belong to the binding resolver (#6), not the loader.
  for (const f of ["uri", "uri-reference", "date", "date-time", "email"]) {
    ajv.addFormat(f, () => true);
  }
  ajv.addSchema(readSchema("connector.schema.json")); // referenced by binding.schema.json

  const capabilities: ValidateFunction = ajv.compile(readSchema("capabilities.schema.json"));
  // cdl.schema.json is compiled (and thus registered by its $id) before the resource and
  // response validators, whose $refs into cdl.schema.json#/$defs/{resourceName,fieldMap} resolve.
  const capability: ValidateFunction = ajv.compile(readSchema("cdl.schema.json"));
  ajv.addSchema(readSchema("response.schema.json")); // referenced by binding.schema.json; refs cdl (registered above)
  ajv.addSchema(readSchema("contract.schema.json")); // referenced by binding.schema.json
  const binding: ValidateFunction = ajv.compile(readSchema("binding.schema.json"));
  const resource: ValidateFunction = ajv.compile(readSchema("resource.schema.json"));

  validators = { capabilities, capability, binding, resource };
  return validators;
}

export interface CapabilitiesFile {
  company: { id: string; name?: string; description?: string };
  capabilities: string[];
  providers: string[];
}

export interface CapabilityDoc {
  file: string;
  capability: {
    id: string;
    description: string;
    effect: "read" | "write" | "irreversible";
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    policies?: string[];
    provider?: string;
    [k: string]: unknown;
  };
}

export interface BindingDoc {
  file: string;
  binding: {
    capabilityId: string;
    connector: Record<string, unknown>;
    response?: Record<string, unknown>; // optional response mapping (ADD-12); resolution/lowering is the compiler's
    contract?: Record<string, unknown>; // optional contract snapshot (ADD-18); lowering is the compiler's
  };
}

export interface ResourceDoc {
  file: string;
  resource: {
    name: string; // optionally domain-qualified: banking.Account or Account
    description?: string;
    fields: Record<string, unknown>; // a fieldMap — resolution/lowering is the compiler's job
  };
}

export interface LoadIssue {
  file: string;
  message: string;
}

export interface LoadResult {
  ok: boolean;
  dir: string;
  capabilities?: CapabilitiesFile;
  capabilityDocs: CapabilityDoc[];
  bindings: BindingDoc[];
  resourceDocs: ResourceDoc[];
  issues: LoadIssue[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "invalid";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .join("; ");
}

/** Load and shape-validate a manifest directory (capabilities.yaml + *.capability.yaml + bindings/). */
export function load(dir: string): LoadResult {
  const { capabilities: validateCapabilities, capability: validateCapability, binding: validateBinding, resource: validateResource } = getValidators();
  const issues: LoadIssue[] = [];
  const capabilityDocs: CapabilityDoc[] = [];
  const bindings: BindingDoc[] = [];
  const resourceDocs: ResourceDoc[] = [];
  let capabilities: CapabilitiesFile | undefined;

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      ok: false,
      dir,
      capabilityDocs,
      bindings,
      resourceDocs,
      issues: [{ file: dir, message: "directory not found" }],
    };
  }

  // 1. capabilities.yaml — the iconic manifest
  const capsPath = join(dir, "capabilities.yaml");
  if (!existsSync(capsPath)) {
    issues.push({ file: "capabilities.yaml", message: "missing (required manifest)" });
  } else {
    try {
      const parsed = parseYaml(readFileSync(capsPath, "utf8"));
      if (validateCapabilities(parsed)) capabilities = parsed as CapabilitiesFile;
      else issues.push({ file: "capabilities.yaml", message: formatErrors(validateCapabilities.errors) });
    } catch (err) {
      issues.push({ file: "capabilities.yaml", message: `parse error: ${(err as Error).message}` });
    }
  }

  // 2. *.capability.yaml — CDL 0.2
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".capability.yaml")).sort()) {
    try {
      const parsed = parseYaml(readFileSync(join(dir, name), "utf8"));
      if (validateCapability(parsed)) capabilityDocs.push({ file: name, ...(parsed as object) } as CapabilityDoc);
      else issues.push({ file: name, message: formatErrors(validateCapability.errors) });
    } catch (err) {
      issues.push({ file: name, message: `parse error: ${(err as Error).message}` });
    }
  }

  // 3. bindings/*.binding.yaml — implementation, separate from CDL
  const bindingsDir = join(dir, "bindings");
  if (existsSync(bindingsDir)) {
    for (const name of readdirSync(bindingsDir).filter((f) => f.endsWith(".binding.yaml")).sort()) {
      try {
        const parsed = parseYaml(readFileSync(join(bindingsDir, name), "utf8"));
        if (validateBinding(parsed)) bindings.push({ file: `bindings/${name}`, ...(parsed as object) } as BindingDoc);
        else issues.push({ file: `bindings/${name}`, message: formatErrors(validateBinding.errors) });
      } catch (err) {
        issues.push({ file: `bindings/${name}`, message: `parse error: ${(err as Error).message}` });
      }
    }
  }

  // 4. *.resource.yaml — named business entities (shape only; name resolution is the compiler's).
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".resource.yaml")).sort()) {
    try {
      const parsed = parseYaml(readFileSync(join(dir, name), "utf8"));
      if (validateResource(parsed)) resourceDocs.push({ file: name, ...(parsed as object) } as ResourceDoc);
      else issues.push({ file: name, message: formatErrors(validateResource.errors) });
    } catch (err) {
      issues.push({ file: name, message: `parse error: ${(err as Error).message}` });
    }
  }

  return { ok: issues.length === 0, dir, capabilities, capabilityDocs, bindings, resourceDocs, issues };
}
