/**
 * Hashline barrel exports.
 * Re-exports everything from the OMP-ported modules plus Synergy adapters.
 */
export * from "./apply"
export * from "./block"
export * from "./diff-preview"
export * from "./format"
export * from "./fs"
export * from "./input"
export * from "./messages"
export * from "./mismatch"
export * from "./normalize"
export * from "./parser"
export * from "./patcher"
export * from "./prefixes"
export * from "./recovery"
export * from "./snapshots"
export * from "./stream"
export * from "./tokenizer"
export * from "./types"

// Compatibility re-exports
export { normalizeContent, splitContentLines } from "./tag"
export { parseHashlinePatch, type HashlinePatch, type PatchOp } from "./patch"
