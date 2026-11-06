import z from "zod"

/**
 * S9c relocation: the canonical symbol-range zod contract lives in L1 next to
 * its persistence owner (MessageV2 symbol attachment sources); the lsp
 * product domain re-exports it from ./schema so both sides parse the same
 * shape. Definitions are byte-identical to the former lsp/schema.ts owner.
 */
export const SymbolRange = z
  .object({
    start: z.object({
      line: z.number(),
      character: z.number(),
    }),
    end: z.object({
      line: z.number(),
      character: z.number(),
    }),
  })
  .meta({
    ref: "Range",
  })
export type SymbolRange = z.infer<typeof SymbolRange>
