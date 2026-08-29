import z from "zod"

/**
 * S9c relocation: the cortex delegation's persisted output/ownership contract
 * (output config, task output, plugin task owner, usage accounting) lives in
 * L1 next to its persistence owner (Session.Info.cortex); the cortex product
 * domain re-exports it from ./types so both sides parse the same shape.
 * Definitions are byte-identical to the former cortex/types.ts owner.
 */
export namespace SessionCortexContract {
  export const PluginTaskOwner = z.object({
    pluginId: z.string(),
    pluginGeneration: z.string(),
    scopeId: z.string(),
    correlationId: z.string(),
  })
  export type PluginTaskOwner = z.infer<typeof PluginTaskOwner>

  export const TaskUsage = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    cost: z.number(),
  })
  export type TaskUsage = z.infer<typeof TaskUsage>

  export const JsonSchemaObject = z.record(z.string(), z.unknown())
  export type JsonSchemaObject = z.infer<typeof JsonSchemaObject>
  const MaxRepairTurns = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])

  export const OutputConfig = z.union([
    z.object({ mode: z.literal("summary").optional() }),
    z.object({ mode: z.literal("final_response") }),
    z.object({
      mode: z.literal("structured"),
      schema: JsonSchemaObject,
      maxRepairTurns: MaxRepairTurns.optional(),
    }),
  ])
  export type OutputConfig = z.infer<typeof OutputConfig>

  export const TaskOutput = z.union([
    z.object({
      mode: z.literal("summary"),
      value: z.string(),
    }),
    z.object({
      mode: z.literal("final_response"),
      value: z.string(),
    }),
    z.object({
      mode: z.literal("structured"),
      value: z.unknown(),
    }),
  ])
  export type TaskOutput = z.infer<typeof TaskOutput>
}
