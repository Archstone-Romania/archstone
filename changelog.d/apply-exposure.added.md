- **`archstone apply <dir> --exposure [--json]`: what a model receives, is shown, and never
  sees** (`@archstone/cli`, `@archstone/compiler`, ADD-309). For each capability the report lists
  its inputs, the output fields a model is shown — each marked as filled by `response.map`, by
  `extract`, or declared but never filled — and every path in the binding's recorded
  `contract.shape` that no mapping reaches, with its observed JSON type and the fixture and
  fingerprint it was observed in. Names and types only; no value appears. Where a binding records
  no shape, the withheld set is reported as unknown rather than empty, and a binding with neither
  `response:` nor `extract:` is reported as passing the provider body through whole. With
  `--json`, `{ "exposure": [...] }` is printed alone on stdout. Without `--exposure`, `apply`
  prints exactly what it printed before, `--json` included. The same report is available to code
  as `exposureOf(tool, resources)` / `exposureOfIR(ir)` from `@archstone/compiler`, pure, with
  `pathTokens(path)` added beside `parsePath` so a static reader of a mapping tokenises it with
  the same grammar the runtime evaluates. For the tourism example: five fields shown, six withheld
  (`boardType`, `commission`, `freeCancellationUntil`, `id`, `net`, `roomDescription`).
