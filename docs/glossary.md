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
| **Extraction** | A model *producing* declared business data — judged against the same Resource Definition |

---

## Extraction

A **Resource Definition** serves both directions of travel. In the direction a Capability runs, it
names what a provider's response is mapped into; in the other, it is the schema a model is
required to *produce* when it extracts business data from unstructured input.

| Outcome | Meaning |
|---|---|
| `ok` | every declared required field present and well-shaped |
| `degraded` | a declared **optional** field is absent; the rest is returned |
| `violation` | a declared **required** field is absent or ill-shaped; the document is withheld whole |

An **undeclared key** — one the model emitted that the manifest does not declare — is neither of
those three. It is dropped from the returned data and listed separately, and it does not change
the outcome. Extraction validation proves *shape*, never *truth*: a correctly-typed invention
passes. See [ADR-0011](adr/0011-undeclared-model-output-never-reaches-a-business-system.md), the
mirror of [ADR-0008](adr/0008-undeclared-provider-data-never-reaches-a-model.md).

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
