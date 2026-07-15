# Archstone Schemas

> **CDL is the product.** The JSON Schemas here validate the Capability Definition Language
> and its bindings; the compiler (`packages/compiler`) lowers them to IR.

Inspired by Kubernetes, OpenAPI, AsyncAPI, and Terraform — but we model **what a business can do**, not how an API is called.

To learn CDL by example, see [`../examples/manifests/`](../examples/manifests/) and the
[onboarding guide](../docs/ONBOARDING.md).

---

## What this standard models (vs OpenAPI)

OpenAPI describes **how** an API can be called (paths, methods, status codes).

**CDL (Capability Definition Language)** describes **what a business can do**:

```yaml
capability:
  id: tourism.search-accommodation
  input:
    destination: { type: location }
  output:
    accommodations: { collection: Accommodation }
```

No REST. No HTTP. No JSON Schema in the authoring file. Bindings are separate.

---

## Schema index

> **CDL 0.2 (Experimental).** `cdl.schema.json` carries `effect` (required),
> `failures`, `lifecycle`, the `ref` field form, and semantic types. The schema files here
> are the normative wire format.

| Schema | File | Role | MVP |
|---|---|---|---|
| **CDL** | [`cdl.schema.json`](cdl.schema.json) | `*.capability.yaml` — business capability (v0.2) | ✅ |
| **Capabilities manifest** | [`capabilities.schema.json`](capabilities.schema.json) | `capabilities.yaml` — iconic AI contract | ✅ |
| **Resource** | [`resource.schema.json`](resource.schema.json) | `*.resource.yaml` — a named business entity (a manifest, not a primitive) | ✅ |
| **Binding** | [`binding.schema.json`](binding.schema.json) | Connector binding for a CDL capability | ✅ |
| **Connector** | [`connector.schema.json`](connector.schema.json) | Wire protocol detail (REST, etc.) | ✅ |
| **Workflow** | [`workflow.schema.json`](workflow.schema.json) | Orchestration order | post-MVP |
| **Execution** | [`execution.schema.json`](execution.schema.json) | Runtime instance record | post-MVP |
| **Policy** | [`policy.schema.json`](policy.schema.json) | Full policy objects | post-MVP |

---

## CDL resource format

```yaml
capability:
  id: tourism.search-accommodation
  description: Find accommodation matching customer preferences.
  input:
    destination: { type: location }
  output:
    accommodations: { collection: Accommodation }
  policies: [authenticated, rate-limited]
  provider: booking-engine
```

Binding (separate file):

```yaml
binding:
  capabilityId: tourism.search-accommodation
  connector:
    type: rest
    rest: { method: POST, path: /api/v1/hotels/search }
```

---

## Validation

```bash
# Compile + validate a manifest end-to-end
pnpm apply examples/manifests/tourism
```

The loader (`@archstone/schema`) validates manifests against these schemas via `ajv`.

---

## Change process

1. Update the JSON Schema here.
2. Bump `apiVersion` if the change is breaking.
3. Update `examples/` to match.
4. Then update the compiler (`packages/compiler`) that consumes the schema.

**Schema before core** — never change compiler behavior without updating the schema first.

---

*Archstone Schema Registry · v1*
