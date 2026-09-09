import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import z from "zod"
import { ProviderPricing } from "@ericsanchezok/synergy-harness/provider/pricing"
import { normalizePublicHttpsOrigin } from "@ericsanchezok/synergy-harness/util/public-https-origin"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
export const Learning = z
  .object({
    alpha: z.number().min(0).max(1).optional().describe("Q-learning step size / learning rate (default: 0.3)"),
    qInit: z.number().optional().describe("Optimistic Q-value initialization per reward dimension (default: 1.0)"),
    dedupIntentThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Intent cosine similarity threshold for deduplicating experiences (default: 0.85)"),
    dedupScriptThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Script cosine similarity threshold for deduplicating experiences (default: 0.8)"),
    qHistorySize: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum Q-value history entries per experience (default: 50)"),
    snapThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Threshold for snapping reward dimensions to discrete {-1, 0, 1} (default: 0.5)"),
    legacyRewardConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Default confidence for legacy scalar reward format (default: 0.3)"),
    encoderRetries: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("LLM retry count for intent/script/reward generation (default: 3)"),
    encoderTimeoutMs: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Wall-clock deadline for a single encoder LLM call in milliseconds (default: 60000)"),
    encoderMaxOutputChars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum characters collected from one encoder model stream before abort (default: 16000)"),
    reencodeConcurrency: z
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .describe("Maximum concurrent experience reencode workers (default: 5)"),
    reencodeRetries: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe(
        "Retry count for transient reencode stages, including model, embedding, session, network, and database operations (default: 3)",
      ),
    reencodeRetryBackoffMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Initial backoff for transient reencode stage retries in milliseconds (default: 1000)"),
    digestToolOutputBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max estimated tokens for tool output in turn digest (default: 800)"),
    encoderToolFieldBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max chars per tool input field in encoder context (default: 500)"),
    encoderToolOutputBudget: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max chars for tool output in encoder context (default: 300)"),
    rewardWeights: z
      .object({
        outcome: z.number().optional().describe("Weight for outcome dimension (default: 0.35)"),
        intent: z.number().optional().describe("Weight for intent dimension (default: 0.25)"),
        execution: z.number().optional().describe("Weight for execution dimension (default: 0.2)"),
        orchestration: z.number().optional().describe("Weight for orchestration dimension (default: 0.1)"),
        expression: z.number().optional().describe("Weight for expression dimension (default: 0.1)"),
      })
      .strict()
      .optional()
      .describe(
        "Weights for multi-dimensional reward composition (default: outcome=0.35, intent=0.25, execution=0.2, orchestration=0.1, expression=0.1)",
      ),
    rewardDelay: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of subsequent turns to wait before evaluating reward (default: 2)"),
  })
  .strict()
  .meta({ ref: "LearningConfig" })

export type Learning = z.infer<typeof Learning>

export const PassiveRetrieval = z
  .object({
    simThreshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum cosine similarity for retrieval candidates (default: 0.7)"),
    topK: z.number().int().min(1).optional().describe("Number of experiences to retrieve (default: 8)"),
    epsilon: z.number().min(0).max(1).optional().describe("ε-greedy exploration probability (default: 0.1)"),
    wSim: z.number().min(0).max(1).optional().describe("Weight for similarity in hybrid score (default: 0.5)"),
    wQ: z.number().min(0).max(1).optional().describe("Weight for Q-value in hybrid score (default: 0.5)"),
    explorationConstant: z
      .number()
      .min(0)
      .optional()
      .describe("UCB1 exploration constant — scales √(ln(N)/n) visit-decay bonus (default: 0.5)"),
  })
  .strict()
  .meta({ ref: "PassiveRetrievalConfig" })

export type PassiveRetrieval = z.infer<typeof PassiveRetrieval>

export const REWARD_WEIGHT_DEFAULTS = {
  outcome: 0.35,
  intent: 0.25,
  execution: 0.2,
  orchestration: 0.1,
  expression: 0.1,
} as const

export const LEARNING_DEFAULTS = {
  alpha: 0.3,
  qInit: 0.5,
  dedupIntentThreshold: 0.85,
  dedupScriptThreshold: 0.8,
  qHistorySize: 50,
  snapThreshold: 0.5,
  legacyRewardConfidence: 0.3,
  encoderRetries: 3,
  encoderTimeoutMs: 60_000,
  encoderMaxOutputChars: 16_000,
  reencodeConcurrency: 5,
  reencodeRetries: 3,
  reencodeRetryBackoffMs: 1_000,
  digestToolOutputBudget: 800,
  encoderToolFieldBudget: 500,
  encoderToolOutputBudget: 300,
  rewardWeights: { ...REWARD_WEIGHT_DEFAULTS },
  rewardDelay: 5,
} as const satisfies Required<Learning>

export const PASSIVE_RETRIEVAL_DEFAULTS = {
  simThreshold: 0.7,
  topK: 8,
  epsilon: 0.1,
  wSim: 0.5,
  wQ: 0.5,
  explorationConstant: 0.5,
} as const satisfies Required<PassiveRetrieval>

export const MEMORY_CATEGORIES = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
  "general",
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

const CategoryRetrieveConfig = z
  .object({
    simThreshold: z.number().optional().describe("Minimum similarity for contextual retrieval"),
    topK: z.number().optional().describe("Maximum contextual entries to retrieve"),
  })
  .strict()

export const LocalEmbeddingConfig = z
  .object({
    source: z
      .enum(["huggingface", "hf-mirror", "custom"])
      .optional()
      .describe("Download source for the bundled local embedding model (default: huggingface)"),
    remoteHost: z.string().url().optional().describe("Public HTTPS origin used when source is custom"),
    cacheDir: z
      .string()
      .optional()
      .describe(
        "Directory where the bundled local embedding model is cached (default: ~/.synergy/data/embedding/models). " +
          "Supports {env:VAR} references.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const source = value.source ?? "huggingface"
    if (source !== "custom") return
    if (!value.remoteHost) {
      ctx.addIssue({
        code: "custom",
        path: ["remoteHost"],
        message: "remoteHost is required when the local embedding source is custom",
      })
      return
    }
    try {
      normalizePublicHttpsOrigin(value.remoteHost)
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["remoteHost"],
        message: error instanceof Error ? error.message : "remoteHost must be a public HTTPS origin",
      })
    }
  })
  .meta({ ref: "LocalEmbeddingConfig" })

export type LocalEmbeddingConfig = z.infer<typeof LocalEmbeddingConfig>

export const EmbeddingConfig = z
  .object({
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z.string().optional().describe("Base URL for the embedding API"),
    apiKey: z.string().optional().describe("API key for the embedding service"),
    model: z.string().optional().describe("Embedding model name"),
    local: LocalEmbeddingConfig.optional().describe("Bundled local embedding model download settings"),
  })
  .strict()
  .optional()
  .meta({ ref: "EmbeddingConfig" })
  .describe("Embedding model configuration. When absent, a local model is used automatically.")

export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>

export const RerankConfig = z
  .object({
    cost: ProviderPricing.Cost.optional().describe(
      "Explicit model prices in USD: token rates per million, unit rates per declared quantity",
    ),
    baseURL: z.string().optional().describe("Base URL for the rerank API"),
    apiKey: z.string().optional().describe("API key for the rerank service"),
    model: z.string().optional().describe("Rerank model name"),
  })
  .strict()
  .optional()
  .meta({ ref: "RerankConfig" })
  .describe("Rerank model for memory retrieval refinement. Disabled when not configured.")

export type RerankConfig = z.infer<typeof RerankConfig>

export const MemoryConfig = z
  .object({
    enabled: z.boolean().optional().describe("Enable agent-initiated memory curation via chronicler (default: true)"),
    retrieval: z
      .object({
        simThreshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum similarity for auto-injection (default: 0.7)"),
        topK: z.number().int().min(1).optional().describe("Max entries per category to retrieve (default: 3)"),
        categories: z
          .record(z.enum(MEMORY_CATEGORIES), CategoryRetrieveConfig)
          .optional()
          .describe("Per-category retrieval overrides"),
      })
      .strict()
      .optional()
      .describe("Semantic memory retrieval settings"),
    dedup: z
      .object({
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Cosine similarity threshold for duplicate detection (default: 0.75)"),
      })
      .strict()
      .optional()
      .describe("Memory deduplication settings"),
  })
  .strict()
  .meta({ ref: "MemoryConfig" })

export type MemoryConfig = z.infer<typeof MemoryConfig>

export const ExperienceConfig = z
  .object({
    encode: z.boolean().optional().describe("Auto-encode conversation patterns into experiences (default: true)"),
    retrieve: z
      .union([z.boolean(), PassiveRetrieval])
      .optional()
      .describe("Inject relevant past experiences into prompts (default: true)"),
    learning: Learning.optional().describe("Q-learning hyperparameters for experience evaluation"),
  })
  .strict()
  .meta({ ref: "ExperienceConfig" })

export type ExperienceConfig = z.infer<typeof ExperienceConfig>

export const LibraryConfig = z
  .object({
    memory: MemoryConfig.optional(),
    experience: ExperienceConfig.optional(),
    autonomy: z
      .boolean()
      .optional()
      .describe("Enable autonomous background routines like anima daily wake (default: true)"),
  })
  .strict()
  .optional()
  .meta({ ref: "LibraryConfig" })

export type LibraryConfig = z.infer<typeof LibraryConfig>

export const ConfigShape = {
  library: LibraryConfig,
  embedding: EmbeddingConfig,
  rerank: RerankConfig,
}

export type ConfigValues = z.output<z.ZodObject<typeof ConfigShape>>

declare module "@ericsanchezok/synergy-harness/config/schema" {
  interface ConfigExtensionShape extends ConfigShapeType {}
}
type ConfigShapeType = typeof ConfigShape

export function registerConfig() {
  ConfigExtensions.register("library", {
    shape: ConfigShape,
    normalize(raw) {
      const result = raw as ConfigValues
      if (result.library) {
        if (result.library.memory === undefined) result.library.memory = { enabled: true }
        if (result.library.memory && !result.library.memory.retrieval) {
          result.library.memory.retrieval = { simThreshold: 0.7, topK: 3 }
        }
        if (result.library.memory && !result.library.memory.dedup) {
          result.library.memory.dedup = { threshold: 0.75 }
        }
        if (result.library.experience === undefined) {
          result.library.experience = { encode: true, retrieve: true, learning: { ...LEARNING_DEFAULTS } }
        }
        if (result.library.autonomy === undefined) result.library.autonomy = true
      }
    },
    redact(raw, helpers) {
      const result = raw as ConfigValues
      const REDACTED_SENTINEL = helpers.sentinel
      const redactSecretShapedRecord = helpers.redact
      const mergeSecretShapedRecord = helpers.restore

      if (result.embedding?.apiKey) result.embedding.apiKey = REDACTED_SENTINEL
      if (result.rerank?.apiKey) result.rerank.apiKey = REDACTED_SENTINEL
    },
    restore(raw, previous, helpers) {
      const result = raw as ConfigValues
      const stored = previous as ConfigValues
      const REDACTED_SENTINEL = helpers.sentinel
      const redactSecretShapedRecord = helpers.redact
      const mergeSecretShapedRecord = helpers.restore

      if (result.embedding?.apiKey === REDACTED_SENTINEL && stored.embedding?.apiKey) {
        result.embedding.apiKey = stored.embedding.apiKey
      }
      if (result.rerank?.apiKey === REDACTED_SENTINEL && stored.rerank?.apiKey) {
        result.rerank.apiKey = stored.rerank.apiKey
      }
    },
  })
  for (const domain of [
    {
      id: "general",
      filename: "00-general.jsonc",
      label: "General",
      ownedKeys: ["embedding", "rerank"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "general",
      importable: true,
    },
    {
      id: "library",
      filename: "30-library.jsonc",
      label: "Library",
      ownedKeys: ["library"],
      mergePolicy: "merge",
      reloadTargets: ["config"],
      uiSection: "library",
      importable: true,
    },
  ] satisfies ConfigDomain.Definition[])
    ConfigDomain.register(domain)
}
registerConfig()

export async function readConfig(): Promise<ConfigValues> {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  return Config.current()
}
