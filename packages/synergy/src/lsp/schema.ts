import { SymbolRange } from "../session/symbol-range"

/**
 * S9c relocation: the canonical Range schema moved to L1
 * (session/symbol-range.ts) next to its persistence owner; this module keeps
 * the lsp domain's LSPSchema.Range surface re-exporting the same schema.
 */
export namespace LSPSchema {
  export const Range = SymbolRange
  export type Range = SymbolRange
}
