import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { LibraryDB } from "../library/database"
import { MemoryRecall } from "../library/memory-recall"
import { ExperienceRecall } from "../library/experience-recall"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { LibraryStatsEngine } from "../library"

const log = Log.create({ service: "server.library" })

// ── Response Schemas ────────────────────────────────────────────────────────

const MemoryCategory = z.enum(LibraryDB.Memory.CATEGORIES).meta({ ref: "MemoryCategory" })
const MemoryRecallMode = z.enum(LibraryDB.Memory.RECALL_MODES).meta({ ref: "MemoryRecallMode" })

const MemoryCardInfo = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  category: MemoryCategory,
  recallMode: MemoryRecallMode,
  createdAt: z.number(),
  updatedAt: z.number(),
})

const MemoryInfo = MemoryCardInfo.meta({ ref: "MemoryInfo" })

const MemorySearchResult = MemoryCardInfo.extend({
  similarity: z.number(),
}).meta({ ref: "MemorySearchResult" })

const RewardsInfo = z
  .object({
    outcome: z.number().optional(),
    intent: z.number().optional(),
    execution: z.number().optional(),
    orchestration: z.number().optional(),
    expression: z.number().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
  })
  .meta({ ref: "RewardsInfo" })

const ExperienceCardInfo = z.object({
  id: z.string(),
  sessionID: z.string(),
  scopeID: z.string(),
  intent: z.string(),
  sourceProviderID: z.string().nullable(),
  sourceModelID: z.string().nullable(),
  reward: z.number().nullable(),
  rewards: RewardsInfo,
  qValue: z.number(),
  qValues: RewardsInfo,
  qVisits: z.number(),
  turnsRemaining: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const ExperienceInfo = ExperienceCardInfo.meta({ ref: "ExperienceInfo" })

const ExperienceDetailInfo = ExperienceCardInfo.extend({
  script: z.string().nullable(),
  raw: z.string().nullable(),
  metadata: z.string(),
}).meta({ ref: "ExperienceDetailInfo" })

const ExperienceSearchResult = ExperienceCardInfo.extend({
  similarity: z.number(),
  score: z.number(),
}).meta({ ref: "ExperienceSearchResult" })

const ExperienceListFilter = z.enum(["all", "scope", "session"]).meta({ ref: "ExperienceListFilter" })
const ExperienceListSort = z
  .enum(["newest", "oldest", "reward", "qvalue", "visits"])
  .meta({ ref: "ExperienceListSort" })

const ExperienceListPage = z
  .object({
    items: ExperienceInfo.array(),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  })
  .meta({ ref: "ExperienceListPage" })

const MemoryStats = z
  .object({
    memory: z.object({ count: z.number() }),
    experience: z.object({ count: z.number() }),
    dbSizeBytes: z.number(),
  })
  .meta({ ref: "MemoryStats" })

const ResetResult = z
  .object({
    deleted: z.object({
      memory: z.number(),
      experience: z.number(),
    }),
  })
  .meta({ ref: "MemoryResetResult" })

// ── Helpers ─────────────────────────────────────────────────────────────────

function toMemoryInfo(row: LibraryDB.Memory.Row): z.infer<typeof MemoryInfo> {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    recallMode: row.recall_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMemorySearchResult(result: MemoryRecall.Result): z.infer<typeof MemorySearchResult> {
  return {
    id: result.id,
    title: result.title,
    content: result.content,
    category: result.category,
    recallMode: result.recallMode,
    similarity: result.similarity,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  }
}

function parseRewards(raw: string): LibraryDB.Experience.Rewards {
  try {
    return JSON.parse(raw) as LibraryDB.Experience.Rewards
  } catch {
    return {}
  }
}

function calculateQValue(qValues: LibraryDB.Experience.Rewards): number {
  const w = Config.REWARD_WEIGHT_DEFAULTS
  return (
    (qValues.outcome ?? 0) * w.outcome +
    (qValues.intent ?? 0) * w.intent +
    (qValues.execution ?? 0) * w.execution +
    (qValues.orchestration ?? 0) * w.orchestration +
    (qValues.expression ?? 0) * w.expression
  )
}

function toExperienceCardInfo(row: LibraryDB.Experience.Row): z.infer<typeof ExperienceInfo> {
  const qValues = parseRewards(row.q_values)
  return {
    id: row.id,
    sessionID: row.session_id,
    scopeID: row.scope_id,
    intent: row.intent,
    sourceProviderID: row.source_provider_id,
    sourceModelID: row.source_model_id,
    reward: row.reward,
    rewards: parseRewards(row.rewards),
    qValue: calculateQValue(qValues),
    qValues,
    qVisits: row.q_visits,
    turnsRemaining: row.turns_remaining,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toExperienceInfo(row: LibraryDB.Experience.Row): z.infer<typeof ExperienceInfo> {
  return toExperienceCardInfo(row)
}

function toExperienceDetail(
  row: LibraryDB.Experience.Row,
  content: LibraryDB.Experience.ContentRow | null,
): z.infer<typeof ExperienceDetailInfo> {
  return {
    ...toExperienceCardInfo(row),
    script: content?.script ?? null,
    raw: content?.raw ?? null,
    metadata: content?.metadata ?? "{}",
  }
}

function toExperienceSearchResult(result: ExperienceRecall.Result): z.infer<typeof ExperienceSearchResult> {
  return {
    id: result.id,
    sessionID: result.sessionID,
    scopeID: result.scopeID,
    intent: result.intent,
    sourceProviderID: result.sourceProviderID,
    sourceModelID: result.sourceModelID,
    reward: result.reward,
    rewards: result.rewards,
    qValue: result.qValue,
    qValues: result.qValues,
    qVisits: result.qVisits,
    turnsRemaining: result.turnsRemaining,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    similarity: result.similarity,
    score: result.score,
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const LibraryRoute = new Hono()

  // ── Experience sub-routes (must be registered before /:id) ──────────────

  .post(
    "/experience/search",
    describeRoute({
      summary: "Search experiences",
      description: "Semantic search across experience records using embedding similarity and Q-value hybrid scoring.",
      operationId: "library.experience.search",
      responses: {
        200: {
          description: "Search results ranked by hybrid score",
          content: { "application/json": { schema: resolver(ExperienceSearchResult.array()) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        query: z.string().meta({ description: "Search query text" }),
        scopeID: z.string().optional().meta({ description: "Filter by scope ID" }),
        topK: z.number().optional().meta({ description: "Max results to return (default: 10)" }),
      }),
    ),
    async (c) => {
      const { query, scopeID, topK } = c.req.valid("json")
      const results = await ExperienceRecall.retrieve(scopeID, query, { topK })
      return c.json(results.map(toExperienceSearchResult))
    },
  )

  .get(
    "/experience/page",
    describeRoute({
      summary: "Page experiences",
      description: "List experience records with server-side filtering, sorting, and pagination.",
      operationId: "library.experience.page",
      responses: {
        200: {
          description: "Paginated experience list",
          content: { "application/json": { schema: resolver(ExperienceListPage) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z
        .object({
          scopeID: z.string().optional().meta({ description: "Scope ID used by scope/session filters" }),
          sessionID: z.string().optional().meta({ description: "Session ID used by session filter" }),
          filter: ExperienceListFilter.optional().default("all").meta({ description: "List filter mode" }),
          sort: ExperienceListSort.optional().default("newest").meta({ description: "Sort order" }),
          limit: z.coerce.number().int().min(1).max(200).optional().default(50).meta({ description: "Page size" }),
          offset: z.coerce.number().int().min(0).optional().default(0).meta({ description: "Page offset" }),
        })
        .superRefine((value, ctx) => {
          if (value.filter === "scope" && !value.scopeID) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["scopeID"],
              message: "scopeID is required when filter is 'scope'",
            })
          }
          if (value.filter === "session" && !value.sessionID) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["sessionID"],
              message: "sessionID is required when filter is 'session'",
            })
          }
        }),
    ),
    async (c) => {
      const query = c.req.valid("query")
      const page = LibraryDB.Experience.page({
        filter: query.filter,
        scopeID: query.scopeID,
        sessionID: query.sessionID,
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
        rewardWeights: Config.REWARD_WEIGHT_DEFAULTS,
      })
      return c.json({
        items: page.items.map(toExperienceInfo),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasMore: page.hasMore,
      })
    },
  )

  .get(
    "/experience/:id",
    describeRoute({
      summary: "Get experience detail",
      description: "Get a specific experience record with its full content (script/raw).",
      operationId: "library.experience.get",
      responses: {
        200: {
          description: "Experience detail",
          content: { "application/json": { schema: resolver(ExperienceDetailInfo) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Experience ID" }) })),
    async (c) => {
      const id = c.req.valid("param").id
      const row = LibraryDB.Experience.get(id)
      if (!row) return c.json({ message: `Experience not found: ${id}` }, 404)
      const content = LibraryDB.Experience.getContent(id)
      return c.json(toExperienceDetail(row, content))
    },
  )

  .delete(
    "/experience/:id",
    describeRoute({
      summary: "Delete experience",
      description: "Delete a specific experience record permanently.",
      operationId: "library.experience.remove",
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Experience ID" }) })),
    async (c) => {
      const id = c.req.valid("param").id
      LibraryDB.Experience.remove(id)
      return c.json(true)
    },
  )

  .put(
    "/experience/:id/reward",
    describeRoute({
      summary: "Apply reward to experience",
      description:
        "Apply an external reward to a specific experience. Use this to inject rewards from benchmark frameworks or custom evaluation pipelines. Provide either a direct composite reward value, or multi-dimensional reward scores.",
      operationId: "library.experience.applyReward",
      responses: {
        200: {
          description: "Reward applied",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ compositeReward: z.number(), rewards: RewardsInfo }).meta({ ref: "ApplyRewardResult" }),
              ),
            },
          },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Experience ID" }) })),
    validator(
      "json",
      z
        .object({
          reward: z.number().min(-1).max(1).optional().meta({ description: "Direct composite reward value [-1, 1]" }),
          rewards: RewardsInfo.optional().meta({ description: "Multi-dimensional reward scores" }),
        })
        .refine((d) => d.reward !== undefined || d.rewards !== undefined, {
          message: "Either 'reward' or 'rewards' must be provided",
        }),
    ),
    async (c) => {
      const id = c.req.valid("param").id
      const body = c.req.valid("json")

      const row = LibraryDB.Experience.get(id)
      if (!row) return c.json({ message: `Experience not found: ${id}` }, 404)

      const config = await Config.current()
      const libraryLearning = (config as any).library?.experience?.learning ?? {}

      const rewards: LibraryDB.Experience.Rewards = body.rewards ?? { outcome: body.reward! }

      const result = LibraryDB.Experience.applyReward(id, {
        rewards,
        rewardWeights: libraryLearning.rewardWeights ?? Config.REWARD_WEIGHT_DEFAULTS,
        alpha: libraryLearning.alpha ?? 0.3,
      })
      if (!result) return c.json({ message: `Failed to apply reward to: ${id}` }, 400)

      log.info("external reward applied", { id, ...result })
      return c.json(result)
    },
  )

  .get(
    "/experience",
    describeRoute({
      summary: "List experiences",
      description: "List all experience records, optionally filtered by project ID.",
      operationId: "library.experience.list",
      responses: {
        200: {
          description: "List of experiences",
          content: { "application/json": { schema: resolver(ExperienceInfo.array()) } },
        },
      },
    }),
    validator(
      "query",
      z.object({
        scopeID: z.string().optional().meta({ description: "Filter by scope ID" }),
      }),
    ),
    async (c) => {
      const { scopeID } = c.req.valid("query")
      const rows = scopeID ? LibraryDB.Experience.list(scopeID) : LibraryDB.Experience.listAll()
      return c.json(rows.map(toExperienceInfo))
    },
  )

  // ── Memory routes ───────────────────────────────────────────────────────

  .get(
    "/stats",
    describeRoute({
      summary: "Get library stats",
      description:
        "Get statistics about the library database. By default returns a summary with counts and DB size. Use ?recompute=true to force a full analytics recompute and return the extended snapshot.",
      operationId: "library.stats",
      responses: {
        200: {
          description: "Library statistics",
          content: { "application/json": { schema: resolver(MemoryStats) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        recompute: z
          .enum(["true", "false"])
          .optional()
          .default("false")
          .meta({ description: "Set to 'true' to force a full analytics recompute" }),
      }),
    ),
    async (c) => {
      const { recompute } = c.req.valid("query")

      if (recompute === "true") {
        try {
          const snapshot = await LibraryStatsEngine.recompute()
          return c.json(snapshot)
        } catch (err: any) {
          return c.json({ message: err?.message ?? String(err) }, 400)
        }
      }

      // Legacy summary format (used by library panel header for counts/dbSizeBytes)
      const dbFile = Bun.file(LibraryDB.dbPath())
      const dbSize = (await dbFile.exists()) ? (await dbFile.stat()).size : 0
      return c.json({
        memory: { count: LibraryDB.Memory.count() },
        experience: { count: LibraryDB.Experience.count() },
        dbSizeBytes: dbSize,
      })
    },
  )

  .post(
    "/search",
    describeRoute({
      summary: "Search memories",
      description:
        "Semantic search across active memories using embedding similarity. Requires embedding API to be configured.",
      operationId: "library.search",
      responses: {
        200: {
          description: "Search results ranked by similarity",
          content: { "application/json": { schema: resolver(MemorySearchResult.array()) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        query: z.string().meta({ description: "Search query text" }),
        topK: z.number().optional().meta({ description: "Max results to return (default: 5)" }),
        categories: z.array(MemoryCategory).optional().meta({ description: "Optional category filters" }),
        recallModes: z.array(MemoryRecallMode).optional().meta({ description: "Optional recall mode filters" }),
      }),
    ),
    async (c) => {
      const { query, topK, categories, recallModes } = c.req.valid("json")
      try {
        const results = await MemoryRecall.search({ query, topK, categories, recallModes })
        return c.json(results.map(toMemorySearchResult))
      } catch (err: any) {
        log.error("search failed", { error: err })
        return c.json(
          { message: `Search failed: ${err?.message ?? String(err)}. Is the embedding API configured?` },
          400,
        )
      }
    },
  )

  .post(
    "/reset",
    describeRoute({
      summary: "Reset memory data",
      description:
        "Reset (delete) memory data by type. Supports resetting active memories, passive experiences, or both. Requires confirm=true to prevent accidental deletion.",
      operationId: "library.reset",
      responses: {
        200: {
          description: "Reset result with deletion counts",
          content: { "application/json": { schema: resolver(ResetResult) } },
        },
        ...errors(400),
      },
    }),
    validator(
      "json",
      z.object({
        type: z.enum(["memory", "experience", "all"]).meta({ description: "What to reset" }),
        scopeID: z.string().optional().meta({ description: "Only for experience: filter by scope ID" }),
        confirm: z.literal(true).meta({ description: "Must be true to confirm the reset operation" }),
      }),
    ),
    async (c) => {
      const { type, scopeID } = c.req.valid("json")
      let deletedMemory = 0
      let deletedExperience = 0

      if (type === "memory" || type === "all") {
        deletedMemory = LibraryDB.Memory.removeAll()
      }

      if (type === "experience" || type === "all") {
        if (scopeID) {
          deletedExperience = LibraryDB.Experience.removeByScope(scopeID)
        } else {
          deletedExperience = LibraryDB.Experience.removeAll()
        }
      }

      log.info("reset", { type, scopeID, deletedMemory, deletedExperience })
      return c.json({ deleted: { memory: deletedMemory, experience: deletedExperience } })
    },
  )

  .get(
    "/:id",
    describeRoute({
      summary: "Get memory",
      description: "Get a specific active memory by ID.",
      operationId: "library.get",
      responses: {
        200: {
          description: "Memory detail",
          content: { "application/json": { schema: resolver(MemoryInfo) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Memory ID" }) })),
    async (c) => {
      const id = c.req.valid("param").id
      const row = LibraryDB.Memory.get(id)
      if (!row) return c.json({ message: `Memory not found: ${id}` }, 404)
      return c.json(toMemoryInfo(row))
    },
  )

  .delete(
    "/:id",
    describeRoute({
      summary: "Delete memory",
      description: "Delete a specific active memory permanently.",
      operationId: "library.remove",
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: resolver(z.boolean()) } },
        },
        ...errors(400),
      },
    }),
    validator("param", z.object({ id: z.string().meta({ description: "Memory ID" }) })),
    async (c) => {
      const id = c.req.valid("param").id
      LibraryDB.Memory.remove(id)
      return c.json(true)
    },
  )

  .get(
    "/",
    describeRoute({
      summary: "List memories",
      description: "List all active (agent-curated) memories, optionally filtered by category.",
      operationId: "library.list",
      responses: {
        200: {
          description: "List of memories",
          content: { "application/json": { schema: resolver(MemoryInfo.array()) } },
        },
      },
    }),
    validator(
      "query",
      z.object({
        category: MemoryCategory.optional().meta({ description: "Filter by a single memory category" }),
        recallMode: MemoryRecallMode.optional().meta({ description: "Filter by a single recall mode" }),
      }),
    ),
    async (c) => {
      const { category, recallMode } = c.req.valid("query")
      const rows =
        category || recallMode
          ? LibraryDB.Memory.list({
              categories: category ? [category] : undefined,
              recallModes: recallMode ? [recallMode] : undefined,
            })
          : LibraryDB.Memory.listAll()
      return c.json(rows.map(toMemoryInfo))
    },
  )
