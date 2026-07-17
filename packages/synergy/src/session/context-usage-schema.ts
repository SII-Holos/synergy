import z from "zod"

const NonNegativeInteger = z.number().int().nonnegative()

const Category = z.object({
  estimatedTokens: NonNegativeInteger,
  attributedTokens: NonNegativeInteger,
  items: NonNegativeInteger.optional(),
})

export const ContextUsageSchema = z.object({
  version: z.literal(1),
  modelID: z.string(),
  providerID: z.string(),
  totalInput: NonNegativeInteger,
  contextLimit: NonNegativeInteger.optional(),
  usableInputLimit: NonNegativeInteger.optional(),
  categories: z.object({
    conversation: Category,
    toolActivity: Category,
    filesReferences: Category,
    instructions: Category,
  }),
  overhead: z.object({
    attributedTokens: NonNegativeInteger,
  }),
  estimator: z.object({
    kind: z.literal("model-tokenizer"),
    encoding: z.string().optional(),
  }),
  reconciliation: z.object({
    mode: z.enum(["residual", "scaled-down"]),
    factor: z.number().nonnegative(),
  }),
  capturedAt: NonNegativeInteger,
})

export type ContextUsageSnapshot = z.infer<typeof ContextUsageSchema>
