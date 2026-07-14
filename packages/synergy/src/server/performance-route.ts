import { type Context, Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "@/config/config"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityLiveEvents } from "@/observability/live-events"
import { PerformanceError } from "@/performance/error"
import { ObservabilityBrowserMetrics } from "@/observability/browser-metrics"
import { ObservabilityIssues } from "@/observability/issues"
import { ObservabilityResources } from "@/observability/resources"
import { ObservabilityStore } from "@/observability/store"
import { PerformanceDashboard } from "@/performance/dashboard"
import { PerformanceInflight } from "@/performance/inflight"
import { PerformanceProjection } from "@/performance/projection"
import { ServerSseMetrics } from "./sse-metrics"
import { PerformanceSchema } from "@/performance/schema"
import { PerformanceTimeline } from "@/performance/timeline"
import { PerformanceTraceDetail } from "@/performance/trace-detail"
import { Log } from "@/util/log"

const SummaryQuery = z
  .object({
    windowMs: z.coerce.number().int().min(1000).max(86_400_000).optional(),
    includeInactive: z.coerce.boolean().optional(),
    scopeID: z.string().optional(),
  })
  .meta({ ref: "PerformanceSummaryQuery" })

const InflightQuery = z.object({
  scopeID: z.string().optional(),
  sessionID: z.string().optional(),
  staleMs: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
const IssuesQuery = z
  .object({
    status: PerformanceSchema.IssueStatus.default("open"),
    severity: PerformanceSchema.IssueSeverity.optional(),
    module: PerformanceSchema.Module.optional(),
    scopeID: z.string().optional(),
    tool: z.string().min(1).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    until: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .meta({ ref: "PerformanceIssuesQuery" })

const TraceDetailQuery = z
  .object({
    includeEvents: z.coerce.boolean().default(true),
    includeAttributes: z.coerce.boolean().default(true),
    maxEvents: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .meta({ ref: "PerformanceTraceDetailQuery" })

const ConfigPatch = PerformanceSchema.Config.partial().meta({ ref: "PerformanceConfigPatch" })

const restartRequiredFields = new Set(["storage.sqliteEnabled"])

const rateBuckets = new Map<string, { count: number; resetAt: number }>()

function clientKey(c: Context) {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local"
}

function rateLimit(c: Context, bucket: string, limit: number | undefined) {
  const max = limit ?? 60
  const now = Date.now()
  const key = `${bucket}:${clientKey(c)}`
  const current = rateBuckets.get(key)
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 })
    return undefined
  }
  current.count++
  if (current.count <= max) return undefined
  const retryAfterMs = Math.max(0, current.resetAt - now)
  c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)))
  c.header("X-RateLimit-Limit", String(max))
  c.header("X-RateLimit-Remaining", "0")
  c.header("X-RateLimit-Reset", String(current.resetAt))
  return c.json({ code: "PERF_RATE_LIMITED", retryAfterMs }, 429)
}

function rejectLargePayload(c: Context, maxBytes: number) {
  const length = Number(c.req.header("content-length") ?? 0)
  if (!Number.isFinite(length) || length <= maxBytes) return undefined
  return c.json({ code: "PERF_INVALID_METRIC_BATCH", message: "Performance metric batch is too large." }, 413)
}

function fail(c: Context, error: PerformanceError) {
  return c.json(error.toResponse(), error.status as 400)
}

function performanceValidator<T extends z.ZodTypeAny>(
  target: "query" | "json" | "param",
  schema: T,
  code: PerformanceError.Code,
) {
  return validator(target, schema, (result, c) => {
    if (result.success) return
    const issues = Array.isArray(result.error)
      ? result.error
      : (result.error as { issues?: unknown[] } | undefined)?.issues
    return c.json({ code, message: "Invalid performance request.", issues }, 400)
  })
}

function handlePerformanceError(c: Context, callback: () => Response | Promise<Response>) {
  try {
    const result = callback()
    if (result instanceof Promise) {
      return result.catch((error) => handleUnknownPerformanceError(c, error))
    }
    return result
  } catch (error) {
    return handleUnknownPerformanceError(c, error)
  }
}

function handleUnknownPerformanceError(c: Context, error: unknown) {
  if (error instanceof PerformanceError) return fail(c, error)
  throw error
}

function ensureStorageAvailable() {
  if (!ObservabilityStore.open()) {
    throw new PerformanceError("PERF_STORAGE_UNAVAILABLE", "Performance SQLite storage is unavailable.", 503)
  }
}

function requiredRestartFields(patch: Partial<PerformanceSchema.Config>) {
  const fields: string[] = []
  if (patch.storage && Object.hasOwn(patch.storage, "sqliteEnabled")) fields.push("storage.sqliteEnabled")
  return fields.filter((field) => restartRequiredFields.has(field))
}

function mergePerformanceConfigPatch(
  current: Awaited<ReturnType<typeof Config.current>>,
  patch: Partial<PerformanceSchema.Config>,
) {
  const raw = (current.observability?.performance ?? {}) as ObservabilityConfig.Raw
  return ObservabilityConfig.effective({
    observability: {
      ...current.observability,
      performance: {
        ...raw,
        ...patch,
        rateLimits: { ...(raw.rateLimits ?? {}), ...(patch.rateLimits ?? {}) },
        storage: { ...(raw.storage ?? {}), ...(patch.storage ?? {}) },
        thresholds: { ...(raw.thresholds ?? {}), ...(patch.thresholds ?? {}) },
      },
    },
  })
}

export const PerformanceRoute = new Hono()
  .get(
    "/performance/summary",
    describeRoute({
      summary: "Get performance summary",
      description: "Get the local Synergy performance dashboard summary.",
      operationId: "performance.summary",
      responses: {
        200: {
          description: "Performance summary",
          content: { "application/json": { schema: resolver(PerformanceSchema.DashboardSummary) } },
        },
      },
    }),
    performanceValidator("query", SummaryQuery, "PERF_INVALID_QUERY"),
    async (c) =>
      handlePerformanceError(c, async () => {
        ensureStorageAvailable()
        return (
          rateLimit(c, "summary", ObservabilityConfig.current().rateLimits.summaryPerMinute) ??
          c.json(await PerformanceDashboard.summary(c.req.valid("query")))
        )
      }),
  )
  .get(
    "/performance/inflight",
    describeRoute({
      summary: "List inflight performance spans",
      description: "List running spans and stale operations from the indexed observability store.",
      operationId: "performance.inflight",
      responses: {
        200: {
          description: "Inflight performance spans",
          content: { "application/json": { schema: resolver(PerformanceSchema.Inflight) } },
        },
      },
    }),
    performanceValidator("query", InflightQuery, "PERF_INVALID_QUERY"),
    (c) =>
      handlePerformanceError(c, () => {
        ensureStorageAvailable()
        return c.json(PerformanceInflight.get(c.req.valid("query")))
      }),
  )
  .get(
    "/performance/timeline",
    describeRoute({
      summary: "Get performance timeline",
      description: "Get bucketed performance metric series for the selected range.",
      operationId: "performance.timeline",
      responses: {
        200: {
          description: "Performance timeline",
          content: { "application/json": { schema: resolver(PerformanceSchema.Timeline) } },
        },
      },
    }),
    performanceValidator("query", PerformanceSchema.TimelineQuery, "PERF_INVALID_QUERY"),
    (c) =>
      handlePerformanceError(c, () => {
        ensureStorageAvailable()
        return (
          rateLimit(c, "timeline", ObservabilityConfig.current().rateLimits.timelinePerMinute) ??
          c.json(PerformanceTimeline.get(c.req.valid("query")))
        )
      }),
  )
  .get(
    "/performance/traces",
    describeRoute({
      summary: "List performance traces",
      description: "List recent redacted performance traces.",
      operationId: "performance.traces.list",
      responses: {
        200: {
          description: "Performance traces",
          content: { "application/json": { schema: resolver(PerformanceSchema.TraceList) } },
        },
      },
    }),
    performanceValidator("query", PerformanceSchema.TraceListQuery, "PERF_INVALID_QUERY"),
    (c) =>
      handlePerformanceError(c, () => {
        ensureStorageAvailable()
        return (
          rateLimit(c, "traces", ObservabilityConfig.current().rateLimits.traceListPerMinute) ??
          c.json(PerformanceTraceDetail.list(c.req.valid("query")))
        )
      }),
  )
  .get(
    "/performance/traces/:traceId",
    describeRoute({
      summary: "Get performance trace detail",
      description: "Get one redacted performance trace with spans and related events.",
      operationId: "performance.traces.detail",
      responses: {
        200: {
          description: "Performance trace detail",
          content: { "application/json": { schema: resolver(PerformanceSchema.TraceDetail) } },
        },
      },
    }),
    performanceValidator("param", z.object({ traceId: z.string() }), "PERF_INVALID_QUERY"),
    performanceValidator("query", TraceDetailQuery, "PERF_INVALID_QUERY"),
    async (c) =>
      handlePerformanceError(c, async () => {
        ensureStorageAvailable()
        return (
          rateLimit(c, "trace-detail", ObservabilityConfig.current().rateLimits.traceDetailPerMinute) ??
          c.json(await PerformanceTraceDetail.detail(c.req.valid("param").traceId, c.req.valid("query")))
        )
      }),
  )
  .get(
    "/performance/issues",
    describeRoute({
      summary: "List filtered performance issues",
      description: "List open or historical performance issues filtered by scope, tool, or last-seen time range.",
      operationId: "performance.issues.list",
      responses: {
        200: {
          description: "Performance issues",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({ generatedAt: z.string(), issues: z.array(PerformanceSchema.Issue) })
                  .meta({ ref: "PerformanceIssues" }),
              ),
            },
          },
        },
      },
    }),
    performanceValidator("query", IssuesQuery, "PERF_INVALID_QUERY"),
    (c) =>
      handlePerformanceError(c, () => {
        ensureStorageAvailable()
        return (
          rateLimit(c, "issues", ObservabilityConfig.current().rateLimits.issueListPerMinute) ??
          c.json({
            generatedAt: new Date().toISOString(),
            issues: ObservabilityIssues.list(c.req.valid("query")).map(PerformanceProjection.issue),
          })
        )
      }),
  )
  .get(
    "/performance/config",
    describeRoute({
      summary: "Get performance config",
      description: "Get effective performance observability configuration and default metadata.",
      operationId: "performance.config.get",
      responses: {
        200: {
          description: "Performance config",
          content: {
            "application/json": {
              schema: resolver(
                z
                  .object({
                    config: PerformanceSchema.Config,
                    defaults: PerformanceSchema.Config,
                    sources: z.array(z.string()),
                  })
                  .meta({ ref: "PerformanceConfigResponse" }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const current = await Config.current()
      return c.json({
        config: ObservabilityConfig.effective(current),
        defaults: ObservabilityConfig.defaults,
        sources: ["runtime.observability.performance"],
      })
    },
  )
  .patch(
    "/performance/config",
    describeRoute({
      summary: "Patch performance config",
      description:
        "Validate and persist runtime performance configuration fields in the runtime observability config domain.",
      operationId: "performance.config.update",
      responses: {
        200: {
          description: "Validated performance config",
          content: { "application/json": { schema: resolver(PerformanceSchema.Config) } },
        },
      },
    }),
    performanceValidator("json", ConfigPatch, "PERF_INVALID_QUERY"),
    async (c) => {
      const limited = rateLimit(c, "config-patch", ObservabilityConfig.current().rateLimits.configPatchPerMinute)
      if (limited) return limited
      const patch = c.req.valid("json")
      const restartFields = requiredRestartFields(patch)
      if (restartFields.length) {
        return c.json({ code: "PERF_CONFIG_RESTART_REQUIRED", fields: restartFields }, 409)
      }
      try {
        const current = await Config.current()
        const nextPerformance = mergePerformanceConfigPatch(current, patch)
        await Config.domainUpdate("runtime", {
          observability: { ...(current.observability ?? {}), performance: nextPerformance },
        })
        ObservabilityConfig.refresh(await Config.current())
        ObservabilityStore.reconfigure()
        ObservabilityResources.reconfigure()
        return c.json(ObservabilityConfig.current())
      } catch (error) {
        Log.create({ service: "performance-route" }).error("Failed to persist performance configuration", { error })
        return c.json({ code: "PERF_CONFIG_CONFLICT", message: "Failed to persist performance configuration." }, 409)
      }
    },
  )
  .post(
    "/performance/browser-metrics",
    describeRoute({
      summary: "Ingest browser performance metrics",
      description: "Validate, redact, and store a batch of frontend/browser performance metrics.",
      operationId: "performance.browserMetrics.ingest",
      responses: {
        200: {
          description: "Browser metrics ingest result",
          content: { "application/json": { schema: resolver(PerformanceSchema.BrowserMetricIngestResult) } },
        },
      },
    }),
    (c, next) => {
      const tooLarge = rejectLargePayload(c, 256 * 1024)
      if (tooLarge) return tooLarge
      const limited = rateLimit(c, "browser-ingest", ObservabilityConfig.current().rateLimits.browserIngestPerMinute)
      if (limited) return limited
      return next()
    },
    performanceValidator("json", PerformanceSchema.BrowserMetricBatch, "PERF_INVALID_METRIC_BATCH"),
    (c) => handlePerformanceError(c, () => c.json(ObservabilityBrowserMetrics.ingest(c.req.valid("json")))),
  )
  .get(
    "/performance/events",
    describeRoute({
      summary: "Subscribe to performance events",
      description: "Server-sent stream for performance dashboard refresh hints and heartbeats.",
      operationId: "performance.events.stream",
      responses: { 200: { description: "Performance event stream" } },
    }),
    performanceValidator(
      "query",
      z.object({
        scopeID: z.string().optional(),
        sessionID: z.string().optional(),
        includeTraces: z.coerce.boolean().default(false),
        heartbeatMs: z.coerce.number().int().min(5000).max(60000).default(15000),
        sinceEventId: z.string().optional(),
      }),
      "PERF_INVALID_QUERY",
    ),
    (c) => {
      const query = c.req.valid("query")
      if (query.includeTraces && !query.sessionID) return c.json({ code: "PERF_FORBIDDEN" }, 403)
      const limited = rateLimit(c, "sse", ObservabilityConfig.current().rateLimits.sseConnectionsPerClient)
      if (limited) return limited
      c.header("X-Accel-Buffering", "no")
      c.header("Cache-Control", "no-cache, no-transform")
      return streamSSE(c, async (stream) => {
        const connectedAt = Date.now()
        ServerSseMetrics.open("performance")
        await stream.writeSSE({
          event: "performance.summary.updated",
          data: JSON.stringify(await PerformanceDashboard.summary({ scopeID: query.scopeID })),
        })
        let pendingWrites = 0
        const maxPendingWrites = ObservabilityConfig.current().perClientSseQueueSize
        const write = (event: string, data: unknown) => {
          if (pendingWrites >= maxPendingWrites) {
            ServerSseMetrics.writeDropped("performance", event)
            return
          }
          pendingWrites++
          void stream
            .writeSSE({ event, data: JSON.stringify(data) })
            .catch(() => ServerSseMetrics.writeFailure("performance", event))
            .finally(() => pendingWrites--)
        }
        const unsubscribe = ObservabilityLiveEvents.subscribe((event) => {
          if (event.type === "issue.raised") {
            if (query.scopeID && (event.issue.scopeID ?? event.issue.evidence.scopeID) !== query.scopeID) return
            if (query.sessionID && event.issue.sessionID !== query.sessionID) return
            write("performance.issue.raised", PerformanceProjection.issue(event.issue))
            return
          }
          if (event.type === "trace.ended") {
            if (!query.includeTraces) return
            if (query.scopeID && event.trace.scopeID !== query.scopeID) return
            if (query.sessionID && event.trace.sessionID !== query.sessionID) return
            write("performance.trace.ended", PerformanceProjection.traceListItem(event.trace))
          }
        })
        const heartbeat = setInterval(() => {
          void stream
            .writeSSE({ event: "heartbeat", data: JSON.stringify({ time: new Date().toISOString() }) })
            .then(() => ServerSseMetrics.heartbeat("performance"))
            .catch(() => ServerSseMetrics.writeFailure("performance", "heartbeat"))
        }, query.heartbeatMs)
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            unsubscribe()
            clearInterval(heartbeat)
            ServerSseMetrics.duration("performance", connectedAt)
            resolve()
          })
        })
      })
    },
  )
