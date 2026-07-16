import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { errors } from "./error"
import { LibraryDB } from "../library/database"
import { MemoryRecall } from "../library/memory-recall"
import { ExperienceRecall } from "../library/experience-recall"
import { ExperienceReencode } from "../library/experience-reencode"
import { detect } from "../library/experience-detect"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Global } from "../global"
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

const ExperienceDetectGroup = z
  .object({
    reason: z
      .string()
      .meta({ description: "Detection reason: too-long, intent-in-raw, encoding_failed, empty, invalid, no-content" }),
    count: z.number(),
    label: z.string().meta({ description: "Human-readable label for this group" }),
    samples: z
      .array(
        z.object({
          id: z.string(),
          detail: z.string(),
          preview: z.string().optional().meta({ description: "First 80 chars of intent or script" }),
        }),
      )
      .meta({ description: "Up to 5 sample items for preview" }),
  })
  .meta({ ref: "ExperienceDetectGroup" })

const ExperienceDetectResult = z
  .object({
    scannedAt: z.number(),
    intent: z.object({
      total: z.number(),
      groups: z.array(ExperienceDetectGroup),
    }),
    script: z.object({
      total: z.number(),
      groups: z.array(ExperienceDetectGroup),
    }),
  })
  .meta({ ref: "ExperienceDetectResult" })

const ReencodeJobStatus = z
  .enum(["running", "completed", "failed", "cancelled", "interrupted"])
  .meta({ ref: "ReencodeJobStatus" })
const ReencodeJobState = z
  .object({
    id: z.string(),
    status: ReencodeJobStatus,
    type: z.enum(["intent", "script"]),
    reason: z.string().nullable(),
    totalCount: z.number().int().min(0),
    okCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
    startedAt: z.number(),
    completedAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .meta({ ref: "ReencodeJobState" })
const ReencodeJobInput = z.object({
  type: z.enum(["intent", "script"]).meta({ description: "What to re-encode" }),
  reason: z.string().optional().meta({ description: "Filter to one detection reason; omit for all" }),
})
const ReencodeJobError = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .meta({ ref: "ReencodeJobError" })
const ReencodeJobConflict = ReencodeJobError.extend({ job: ReencodeJobState }).meta({
  ref: "ReencodeJobConflict",
})

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

  // ── Experience detect & reencode ──────────────────────────────────────

  .post(
    "/experience/detect",
    describeRoute({
      summary: "Detect experience encoding issues",
      description:
        "Scan the experience database for encoding quality issues. Groups candidates by detection reason and returns up to 5 samples per group.",
      operationId: "library.experience.detect",
      responses: {
        200: {
          description: "Detection results grouped by type and reason",
          content: { "application/json": { schema: resolver(ExperienceDetectResult) } },
        },
        ...errors(400),
      },
    }),
    async (c) => {
      const dbPath = Global.Path.libraryDB
      const raw = detect(dbPath)
      const scannedAt = Date.now()

      const reasonLabels: Record<string, string> = {
        encoding_failed: "Encoding pipeline failed",
        empty: "Intent is empty",
        "too-long": "Intent too long (>150 chars)",
        "intent-in-raw": "Intent copied from raw user message",
        invalid: "Intent.isValid returned false",
        "no-content": "No experience content record",
      }

      const preview = (text?: string) => (text ? text.slice(0, 80) : undefined)

      function buildGroups(
        candidates: Array<{ id: string; reason: string; detail: string; intent?: string; script?: string }>,
      ) {
        const groups = new Map<
          string,
          { count: number; samples: Array<{ id: string; detail: string; preview?: string }> }
        >()
        for (const c of candidates) {
          let entry = groups.get(c.reason)
          if (!entry) {
            entry = { count: 0, samples: [] }
            groups.set(c.reason, entry)
          }
          entry.count++
          if (entry.samples.length < 5) {
            entry.samples.push({
              id: c.id,
              detail: c.detail,
              preview: preview(c.intent ?? c.script),
            })
          }
        }
        // Sort by count descending (most frequent first)
        return Array.from(groups.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .map(([reason, group]) => ({
            reason,
            count: group.count,
            label: reasonLabels[reason] ?? reason,
            samples: group.samples,
          }))
      }

      return c.json({
        scannedAt,
        intent: { total: raw.intent.length, groups: buildGroups(raw.intent) },
        script: { total: raw.script.length, groups: buildGroups(raw.script) },
      })
    },
  )

  .post(
    "/experience/reencode/jobs",
    describeRoute({
      summary: "Start an experience reencode job",
      description: "Create a durable server-owned reencode job and return its initial state.",
      operationId: "library.experience.startReencodeJob",
      responses: {
        200: {
          description: "Reencode job state",
          content: { "application/json": { schema: resolver(ReencodeJobState) } },
        },
        409: {
          description: "A reencode job is already running",
          content: { "application/json": { schema: resolver(ReencodeJobConflict) } },
        },
        ...errors(400),
      },
    }),
    validator("json", ReencodeJobInput),
    async (c) => {
      const active = ExperienceReencode.currentSummary()
      if (active?.status === "running") {
        return c.json(
          {
            code: "REENCODE_JOB_ALREADY_RUNNING",
            message: "An experience reencode job is already running",
            job: active,
          },
          409,
        )
      }

      try {
        return c.json(ExperienceReencode.start(c.req.valid("json")))
      } catch (error) {
        const current = ExperienceReencode.currentSummary()
        if (current?.status === "running") {
          return c.json(
            {
              code: "REENCODE_JOB_ALREADY_RUNNING",
              message: "An experience reencode job is already running",
              job: current,
            },
            409,
          )
        }
        throw error
      }
    },
  )

  .get(
    "/experience/reencode/jobs/current",
    describeRoute({
      summary: "Get the current experience reencode job",
      description: "Return the most recently created reencode job with durable aggregate progress.",
      operationId: "library.experience.getReencodeJob",
      responses: {
        200: {
          description: "Current reencode job state",
          content: { "application/json": { schema: resolver(ReencodeJobState) } },
        },
        404: {
          description: "No reencode job exists",
          content: { "application/json": { schema: resolver(ReencodeJobError) } },
        },
      },
    }),
    async (c) => {
      const current = ExperienceReencode.currentSummary()
      if (!current) {
        return c.json({ code: "REENCODE_JOB_NOT_FOUND", message: "No reencode job exists" }, 404)
      }
      return c.json(current)
    },
  )

  .post(
    "/experience/reencode/jobs/current/cancel",
    describeRoute({
      summary: "Cancel the current experience reencode job",
      description: "Cancel the active server-owned job without discarding completed item results.",
      operationId: "library.experience.cancelReencodeJob",
      responses: {
        200: {
          description: "Cancelled reencode job state",
          content: { "application/json": { schema: resolver(ReencodeJobState) } },
        },
        404: {
          description: "No reencode job exists",
          content: { "application/json": { schema: resolver(ReencodeJobError) } },
        },
        409: {
          description: "The current job is not running",
          content: { "application/json": { schema: resolver(ReencodeJobConflict) } },
        },
      },
    }),
    async (c) => {
      const current = ExperienceReencode.currentSummary()
      if (!current) {
        return c.json({ code: "REENCODE_JOB_NOT_FOUND", message: "No reencode job exists" }, 404)
      }
      if (current.status !== "running") {
        return c.json(
          {
            code: "REENCODE_JOB_NOT_RUNNING",
            message: "The current experience reencode job is not running",
            job: current,
          },
          409,
        )
      }
      return c.json(await ExperienceReencode.cancel(current.id))
    },
  )

  .post(
    "/experience/reencode",
    describeRoute({
      summary: "Observe experience reencoding",
      description:
        "Compatibility SSE observer for the durable reencode job. Disconnecting closes only the observer; the server-owned job continues.",
      operationId: "library.experience.reencode",
      responses: {
        200: {
          description: "SSE stream of reencode job progress",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.object({
                  type: z.enum(["start", "progress", "done", "error"]),
                  total: z.number().optional(),
                  id: z.string().optional(),
                  status: z.string().optional(),
                  reason: z.string().optional(),
                  completed: z.number().optional(),
                  ok: z.number().optional(),
                  skipped: z.number().optional(),
                  failed: z.number().optional(),
                  message: z.string().optional(),
                }),
              ),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator("json", ReencodeJobInput),
    async (c) => {
      const input = c.req.valid("json")
      let job = ExperienceReencode.currentSummary()
      if (!job || job.status !== "running") job = ExperienceReencode.start(input)

      c.header("X-Accel-Buffering", "no")
      c.header("Cache-Control", "no-cache, no-transform")

      return streamSSE(c, async (stream) => {
        const emitted = new Set<string>()
        let updatedAt = 0

        await stream.writeSSE({ data: JSON.stringify({ type: "start", total: job.totalCount }) })

        while (true) {
          if (stream.aborted) return
          const latest = ExperienceReencode.getSummary(job.id)
          if (!latest) {
            await stream.writeSSE({ data: JSON.stringify({ type: "error", message: "Reencode job disappeared" }) })
            return
          }

          const updates = ExperienceReencode.terminalItemsSince(job.id, updatedAt)
          for (const item of updates) {
            updatedAt = Math.max(updatedAt, item.updatedAt)
            if (emitted.has(item.id)) continue
            emitted.add(item.id)
            await stream.writeSSE({
              data: JSON.stringify({
                type: "progress",
                id: item.id,
                status: item.status,
                reason: item.reason,
                completed: emitted.size,
              }),
            })
          }

          if (latest.status !== "running") {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "done",
                status: latest.status,
                total: latest.totalCount,
                ok: latest.okCount,
                skipped: latest.skippedCount,
                failed: latest.failedCount,
                message: latest.error ?? undefined,
              }),
            })
            return
          }

          await Bun.sleep(500)
        }
      })
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
