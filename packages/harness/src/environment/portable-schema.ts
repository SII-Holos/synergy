import { z } from "zod"

export namespace EnvironmentPortableSchema {
  const ID = z.string().min(1).max(4096)
  export const Descriptor = z.strictObject({
    version: z.literal(1),
    kind: z.literal("native"),
    platform: z.string().min(1).max(64),
    architecture: z.string().min(1).max(64),
    capabilities: z.array(z.enum(["exec", "pty", "files"])).refine((items) => new Set(items).size === items.length),
  })
  export type Descriptor = z.infer<typeof Descriptor>
  export const Selection = z.strictObject({
    environmentID: ID,
    provider: ID,
    generation: z.number().int().nonnegative().safe(),
    state: z.enum(["idle", "ready"]),
    descriptor: Descriptor,
  })
  export type Selection = z.infer<typeof Selection>
  export const Source = z.strictObject({
    version: z.literal(1),
    kind: z.literal("source"),
    scopeID: ID,
    sessionID: ID,
    rootSessionID: ID,
    handoffID: ID,
    selected: Selection.nullable(),
  })
  export type Source = z.infer<typeof Source>
  export const Receipt = z
    .strictObject({
      version: z.literal(1),
      kind: z.literal("receipt"),
      source: Source,
      target: Selection.nullable(),
    })
    .refine(({ source, target }) =>
      source.selected === null
        ? target === null
        : target !== null &&
          source.selected.provider === target.provider &&
          JSON.stringify(source.selected.descriptor) === JSON.stringify(target.descriptor),
    )
  export type Receipt = z.infer<typeof Receipt>
  export const Record = z.discriminatedUnion("kind", [Source, Receipt])
  export type Record = z.infer<typeof Record>
}
