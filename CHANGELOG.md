# Changelog

All notable changes to Archstone are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Typed resource output.** `*.resource.yaml` definitions are now loaded and resolved by the
  compiler: a capability output field like `collection: Stay` (or any `ref`/resource-typed
  field) resolves against a named resource, and the MCP emitter lowers the resolved fields
  into a typed, described `outputSchema` on the tool. Agents now see a resource's real shape
  (e.g. `Stay.name` / `location` / `pricePerNight` / `rating`) instead of a bare
  `{type: object}`/`{type: array}`.
- **Response mapping.** A binding may declare a `response:` block that maps a live provider's
  HTTP response onto the resource its tool outputs (`collection` JSONPath + a resource-field →
  provider-path `map`). At invocation, the runtime applies the mapping and validates it against
  the resource's required fields:
  - all required fields present → **OK**, mapped data returned as `structuredContent`;
  - an optional field missing → **DEGRADED**, returned with that field omitted and a warning;
  - a required field missing → **VIOLATION**, fail-closed — `isError:true` with a human-readable
    `content` message plus a structured error in `_meta["dev.archstone/contract_violation"]`
    (`{error: "contract_violation", capability, missing}`) — never a raw pass-through of the
    provider's body. Agents branch on the structured field, not parsed prose.
- **`archstone verify`.** New CLI command. For every binding with a `contract:` block, it
  replays the recorded request in `fixtures/<capabilityId>.golden.json` against the **live**
  backend, runs the response through the same mapping a real tool call would use, fingerprints
  the response shape, and reports a per-binding health status (🟢 unchanged / 🟡 shape drifted
  or degraded / 🔴 a required field is missing or the request failed). Exits non-zero on any
  🔴, so it drops into CI as a contract-drift gate. It is the only command that makes a live
  network call outside a real tool invocation, and is on-demand only — never triggered by
  `apply` or `serve`.

### Changed

- A capability output that references an unresolved resource name is now a **compile error**
  (`unknown-resource`) instead of silently lowering to a generic `object`/`array`.

### Breaking

- Manifests using `collection:`/`ref:` output fields need a matching `*.resource.yaml` to
  compile. See [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for how to author one.

## [0.1.0]

Initial MVP walking skeleton: CDL manifest → schema validation → semantic validation →
compile to IR → MCP tools served over stdio, demoed end-to-end against Claude Desktop.
