- **`archstone init`: an OpenAPI list of `oneOf[success, error]` rows now maps onto
  `response.onError`** (`@archstone/init`, ADD-12 §8.1 / §8.4 item 1). When a list's items are a
  `oneOf` of two object branches and exactly one branch declares exactly one property with a
  scalar `const`, that branch is the error row: the binding gets
  `onError: { errorResource: <Success>Error, when: { path: $.<property>, equals: <const> } }`,
  plus a `map:` only for a field whose source is not `$.code` / `$.message`, and a
  `<Success>Error` resource with the fields `code` and `message` is emitted beside the success
  resource. `code` reads from the error branch's `code`, else from the discriminator itself;
  `message` from its `message`, else from its one remaining plain string property. Such an
  operation used to be skipped as `unsupported-composition`. Every other two-branch `oneOf` is
  still refused, now under a reason code naming what is missing — `oneof-too-many-branches`,
  `oneof-no-discriminator`, `oneof-non-object-branch`, `oneof-error-fields-unresolved` — and the
  accepted form anywhere but the items of the collection being mapped (the response root, a
  single-object property, a nested list, or when the root locus is chosen) is refused as
  `oneof-outside-collection` rather than flattened into its success shape. `anyOf`, a
  `discriminator` keyword, and the nullability idiom (`oneOf: [X, {type: 'null'}]`) behave
  exactly as before.
