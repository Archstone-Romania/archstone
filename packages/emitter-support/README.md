# @archstone/emitter-support

Shared, IR-only substrate for Archstone emitters (ADD-0008 / RFC-0008): IR indexing
(`Registry`), semantic-type → JSON-Schema lowering, tool-name sanitization, and the
response-mapping executor. Depends only on `@archstone/compiler` — no MCP SDK, no
`node:fs`, no HTTP — so any emitter built on it (the MCP server in `@archstone/runtime`
today, the embedded agent in `@archstone/agent` later) can be tree-shaken cleanly.

Part of [Archstone](https://github.com/Archstone-Romania/archstone), an open-source
Capability Platform — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
