// @archstone/runtime — Response mapper (ADD-12 / RFC-0006)
//
// Moved to @archstone/emitter-support (ADD-0008 #27), unchanged logic — re-exported here for
// back-compat so nothing downstream breaks (verify.ts and existing consumers still import
// from "./mapping").
export { applyResponseMapping, type MappingStatus, type MappingResult } from "@archstone/emitter-support";
