# Examples

Valid CDL manifests — they pass schema validation and compile end to end.

---

## Manifests

Deployable CDL — `capabilities.yaml` + `*.capability.yaml` + `bindings/`.

| Manifest | What |
|---|---|
| [`manifests/tourism/`](manifests/tourism/) | Demo: one bound `tourism.search` capability |
| [`manifests/booking/`](manifests/booking/) | Fuller: 4 capabilities, provider mapping, bound + unbound |
| [`manifests/bank/`](manifests/bank/) | Banking capabilities incl. an irreversible transfer |

---

## Apply

```bash
pnpm apply examples/manifests/tourism
```

---

*Examples follow schemas — not the other way around*
