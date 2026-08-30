# Extracting a `tourism.Stay` from a booking email

The other direction of travel, made runnable.

Everywhere else in these examples the business answers and Archstone decides what reaches the
model. Here the **model** produces the business data — it reads a booking email and emits a
`tourism.Stay` — and Archstone decides what reaches the business system.
[ADR-0011](../../../docs/adr/0011-undeclared-model-output-never-reaches-a-business-system.md).

```bash
pnpm --filter archstone-demo-extract-stay start
```

No API key, no network, no model call. The four responses are **recorded**: this demo is about
what the boundary does with an answer, and a live model would make the same run print something
different every time.

It uses the shipped [`tourism`](../../manifests/tourism/) manifest unmodified — the same
`tourism.Stay` that `tourism.search` returns is, without a line of new declaration, the schema
the model is required to produce.

## What it prints

Four responses to the same email, and the four things that can happen to one:

| Response | Outcome |
|---|---|
| every declared field, well-shaped | `ok` |
| the optional `rating` absent | `degraded` — the rest is returned, the absence is named |
| the required `pricePerNight` absent | `violation` — the document is withheld whole |
| a `confidence` field nobody declared | `ok`, key **dropped** from `data` and listed in `undeclared` |

The last one is the point of the whole record. The model emitted a field the manifest does not
declare; it does not reach the returned data, and it is not silently discarded either.

## What this demo is not

`ok` does not mean the extraction is **right**. A model that invents a plausible, correctly-typed
stay passes every check here. The boundary proves shape, never truth — the same way a green
`archstone verify` means the provider still answers in the recorded shape, not that its answers
are correct.
