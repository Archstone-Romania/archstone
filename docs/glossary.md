# Glossary

> Authoritative vocabulary for Project Archstone / Capability Platform.

**Source of truth:** RFC-000A — Foundational Concepts (internal). The normative grammar is
the [CDL Specification](cdl-specification.md).

---

## Quick reference

| Term | One line |
|---|---|
| **Capability** | What the business can do |
| **Connector** | How it is done |
| **Provider** | Who does it |
| **Policy** | Under what conditions |
| **Workflow** | In what order |
| **Execution** | Which run happened |
| **CDL** | Capability Definition Language — business-only DSL |
| **Capability manifest** | `*.capability.yaml` — one deployable capability |
| **Capabilities manifest** | `capabilities.yaml` — iconic contract with the AI world |
| **Capability Registry** | Catalog — loaded via `archstone apply` |
| **Capability Platform** | The product |
| **Capability Runtime** | Execution engine in `core/` |
| **Tool** | MCP/protocol view of a Capability |
| **Gateway** | Ingress component — not the product |

---

## Schema mapping

| Concept | JSON Schema |
|---|---|
| Capability (CDL) | `../../schemas/cdl.schema.json` |
| Capabilities manifest | `../../schemas/capabilities.schema.json` |
| Binding | `../../schemas/binding.schema.json` |
| Workflow | `../../schemas/workflow.schema.json` |
| Execution | `../../schemas/execution.schema.json` |
| Policy | `../../schemas/policy.schema.json` |

Do not redefine terms here — propose changes via RFC-000A revision.
