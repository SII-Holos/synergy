import { z } from "zod"

const NonNegativeInteger = z.number().int().nonnegative()

export const ContextCategoryKeys = [
  "systemInstructions",
  "toolDefinitions",
  "userMessages",
  "injectedContext",
  "skills",
  "assistantMessages",
  "toolResults",
  "attachments",
] as const
export type ContextCategoryKey = (typeof ContextCategoryKeys)[number]
export const ContextCategory = z.enum([
  ...ContextCategoryKeys,
  "legacyConversation",
  "legacyTools",
  "legacyInstructions",
])

export const ContextSourceSchema = z.object({
  category: z.enum(ContextCategoryKeys),
  path: z.array(z.string()),
  selector: z.array(z.string()).optional(),
  range: z.object({ start: NonNegativeInteger, end: NonNegativeInteger }).optional(),
  source: z.string(),
  messageID: z.string().optional(),
  partID: z.string().optional(),
  characters: NonNegativeInteger,
  precision: z.enum(["source", "role"]),
})

const Category = z.object({
  category: ContextCategory,
  precision: z.enum(["source", "role", "legacy"]),
  estimatedTokens: NonNegativeInteger,
  attributedTokens: NonNegativeInteger,
  items: NonNegativeInteger.optional(),
})

const Estimator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model-tokenizer"), encoding: z.string().optional() }),
  z.object({
    kind: z.literal("bounded-utf8"),
    sampledCharacters: NonNegativeInteger,
    truncated: z.boolean(),
  }),
])

export const ContextUsageDraftSchema = z.object({
  modelID: z.string(),
  providerID: z.string(),
  contextLimit: NonNegativeInteger.optional(),
  usableInputLimit: NonNegativeInteger.optional(),
  categories: z.record(
    z.enum(ContextCategoryKeys),
    z.object({
      estimatedTokens: NonNegativeInteger,
      items: NonNegativeInteger,
      precision: z.enum(["source", "role"]).optional(),
    }),
  ),
  estimator: Estimator,
})

export const ContextUsageEstimateSchema = ContextUsageDraftSchema.extend({
  version: z.literal(1),
  capturedAt: NonNegativeInteger,
}).meta({ ref: "ContextUsageEstimate" })

export type ContextUsageDraft = z.infer<typeof ContextUsageDraftSchema>
export type ContextUsageEstimate = z.infer<typeof ContextUsageEstimateSchema>

export const ContextUsageSchema = z.object({
  version: z.literal(2),
  callID: z.string().optional(),
  modelID: z.string(),
  providerID: z.string(),
  totalInput: NonNegativeInteger,
  contextLimit: NonNegativeInteger.optional(),
  usableInputLimit: NonNegativeInteger.optional(),
  categories: z.array(Category),
  overhead: z.object({
    attributedTokens: NonNegativeInteger,
  }),
  estimator: Estimator,
  reconciliation: z.object({
    mode: z.enum(["residual", "scaled-down"]),
    factor: z.number().nonnegative(),
  }),
  capturedAt: NonNegativeInteger,
})

export type ContextUsageSnapshot = z.infer<typeof ContextUsageSchema>
