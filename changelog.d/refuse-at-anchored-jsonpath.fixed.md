- **`archstone apply` accepted JSONPath expressions anchored at `@` that could never be
  evaluated.** A `response.map`, `collection`, `extract` or `onError` path such as `@.name`
  passed validation, then failed at every invocation because jsonpath-plus throws "Unknown value
  type" for a path that starts with `@`. Such paths are now a `bad-response-path` /
  `bad-extract-path` error at apply time; `@` remains valid inside a filter expression
  (`$.rooms[?(@.available)]`).
