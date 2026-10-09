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

export const ContextUsageSchema = z.object({
  version: z.literal(2),
  modelID: z.string(),
  providerID: z.string(),
  totalInput: NonNegativeInteger,
  contextLimit: NonNegativeInteger.optional(),
  usableInputLimit: NonNegativeInteger.optional(),
  categories: z.array(Category),
  overhead: z.object({
    attributedTokens: NonNegativeInteger,
  }),
  estimator: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("model-tokenizer"),
      encoding: z.string().optional(),
    }),
    z.object({
      kind: z.literal("bounded-utf8"),
      sampledCharacters: NonNegativeInteger,
      truncated: z.boolean(),
    }),
  ]),
  reconciliation: z.object({
    mode: z.enum(["residual", "scaled-down"]),
    factor: z.number().nonnegative(),
  }),
  capturedAt: NonNegativeInteger,
})

export type ContextUsageSnapshot = z.infer<typeof ContextUsageSchema>
