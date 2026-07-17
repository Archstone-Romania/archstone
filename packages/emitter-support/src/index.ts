// @archstone/emitter-support — shared substrate for IR-based emitters (ADD-0008 / RFC-0008)
//
// IR indexing (Registry), semantic-type → JSON-Schema lowering, tool-name sanitization, and
// the response-mapping executor. IR-only: no MCP SDK, no fs, no HTTP — the neutral ground
// both the MCP emitter (@archstone/runtime) and the embedded agent (@archstone/agent,
// RFC-0008 #28) build on.
export * from "./registry";
export * from "./lowering";
export * from "./mapping";
