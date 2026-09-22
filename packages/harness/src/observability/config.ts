import { RuntimeContext } from "../lifecycle/context"
import z from "zod"

export namespace ObservabilityConfig {
  const runtimeState = RuntimeContext.state(() => ({
    dirty: true,
    cached: undefined as Info | undefined,
    mirrorEnabled: false,
  }))

  // Resolved from the observability domain rather than the performance schema,
  // so the opt-in log mirror never widens the performance config API.
  export function logMirror() {
    const instanceState = runtimeState()

    return instanceState.mirrorEnabled
  }

  export function current() {
    const instanceState = runtimeState()

    if (instanceState.cached && !instanceState.dirty) return instanceState.cached
    instanceState.cached = effective()
    instanceState.dirty = false
    return instanceState.cached
  }

  export function refresh(input?: {
    observability?: { enabled?: boolean; maxBytes?: number; logMirror?: boolean; performance?: Raw }
  }) {
    const instanceState = runtimeState()

    if (input) {
      instanceState.mirrorEnabled = input.observability?.logMirror === true
      instanceState.cached = effective(input)
      instanceState.dirty = false
      return
    }
    instanceState.mirrorEnabled = false
    instanceState.dirty = true
  }

  export interface Raw {
    enabled?: boolean
    samplingRate?: number
    metricRetentionMs?: number
    traceRetentionMs?: number
    resourceSampleIntervalMs?: number
    slowTraceThresholdMs?: number
    maxTraceEvents?: number
    maxTimelineBuckets?: number
    maxTraceListLimit?: number
    maxAttributeStringLength?: number
    dashboardRefreshMs?: number
    sseHeartbeatMs?: number
    sseBufferSize?: number
    perClientSseQueueSize?: number
    redactAttributeKeys?: string[]
    rateLimits?: Record<string, number | undefined>
    storage?: {
      sqliteEnabled?: boolean
      jsonlMirrorEnabled?: boolean
      maxSqliteBytes?: number
      retentionBytes?: number
      retentionMs?: number
      walCheckpointIntervalMs?: number
      requestDeadlineMs?: number
      probeTimeoutMs?: number
      probeAttempts?: number
      hardCeilingMs?: number
      chunkBudgetMs?: number
    }
    thresholds?: Record<string, number | undefined>
  }

  export const Schema = z.object({
    enabled: z.boolean(),
    samplingRate: z.number(),
    metricRetentionMs: z.number(),
    traceRetentionMs: z.number(),
    resourceSampleIntervalMs: z.number(),
    slowTraceThresholdMs: z.number(),
    maxTraceEvents: z.number(),
    maxTimelineBuckets: z.number(),
    maxTraceListLimit: z.number(),
    maxAttributeStringLength: z.number(),
    dashboardRefreshMs: z.number(),
    sseHeartbeatMs: z.number(),
    sseBufferSize: z.number(),
    perClientSseQueueSize: z.number(),
    rateLimits: z.record(z.string(), z.number()).default({}),
    redactAttributeKeys: z.array(z.string()),
    storage: z.object({
      sqliteEnabled: z.boolean(),
      jsonlMirrorEnabled: z.boolean(),
      maxSqliteBytes: z.number(),
      retentionBytes: z.number(),
      retentionMs: z.number(),
      walCheckpointIntervalMs: z.number(),
      requestDeadlineMs: z.number(),
      probeTimeoutMs: z.number(),
      probeAttempts: z.number(),
      hardCeilingMs: z.number(),
      chunkBudgetMs: z.number(),
    }),
    thresholds: z.record(z.string(), z.number()),
  })
  export type Info = z.infer<typeof Schema>

  export const defaults = {
    enabled: true,
    samplingRate: 1,
    metricRetentionMs: 24 * 60 * 60 * 1000,
    traceRetentionMs: 24 * 60 * 60 * 1000,
    resourceSampleIntervalMs: 5000,
    slowTraceThresholdMs: 5000,
    maxTraceEvents: 2000,
    maxTimelineBuckets: 300,
    maxTraceListLimit: 200,
    maxAttributeStringLength: 512,
    dashboardRefreshMs: 5000,
    sseHeartbeatMs: 15000,
    sseBufferSize: 1000,
    perClientSseQueueSize: 100,
    rateLimits: {
      summaryPerMinute: 120,
      timelinePerMinute: 60,
      traceListPerMinute: 60,
      traceDetailPerMinute: 120,
      issueListPerMinute: 120,
      browserIngestPerMinute: 60,
      configPatchPerMinute: 20,
      analysisPerMinute: 6,
      sseConnectionsPerClient: 4,
    },
    redactAttributeKeys: [
      "token",
      "secret",
      "password",
      "authorization",
      "cookie",
      "set-cookie",
      "apiKey",
      "api_key",
      "prompt",
      "completion",
      "content",
      "body",
      "headers",
      "env",
      "stack",
    ],
    storage: {
      sqliteEnabled: true,
      jsonlMirrorEnabled: false,
      maxSqliteBytes: 250 * 1024 * 1024,
      // A backstop above the retention window's steady state rather than a
      // target. Measured heavy use produced ~4GB/day of evidence at roughly 5x
      // storage overhead, so a 7-day window can exceed this: a budget at or
      // below that is unreachable and makes every sweep delete destructively
      // without converging. A window whose steady state does not fit is
      // reported as a reduced window instead of being pruned in a loop.
      retentionBytes: 40 * 1024 ** 3,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      walCheckpointIntervalMs: 60_000,
      requestDeadlineMs: 30_000,
      // One probe budget mirrors the ordinary request deadline. Probes are
      // retried because a single unanswered probe only means the worker is
      // busy; it takes `hardCeilingMs` of sustained silence to mean a wedge.
      probeTimeoutMs: 30_000,
      probeAttempts: 3,
      // This ceiling must exceed the longest *legitimate* statement, because three
      // maintenance statements cannot be chunked or cancelled: SQLite has no
      // partial `CREATE INDEX`, `PRAGMA integrity_check` is a single engine call
      // that `bun:sqlite` offers no progress callback for, and `VACUUM` rewrites
      // every page of the database.
      //
      // The measurement is noisy enough that this has to be read as a range rather
      // than a number. The physical check took 17-33 s at 920,000 records and
      // 140-280 s at 2,760,000 records -- a two-fold spread on the *same file*,
      // because whether the store fits in page cache decides most of the cost.
      // Extrapolating the slowest run to the 15.1M records of the store this work
      // came from puts that one statement in the neighbourhood of 22 minutes, and
      // the spread means the true figure is not pinned. `VACUUM` measured 36 s at
      // the smaller fixture, which projects to roughly nine minutes at the larger.
      //
      // None of the three fits comfortably inside the five minutes the previous
      // ceiling allowed, and the check runs while a migration is activating, so a
      // ceiling inside that range could kill a healthy worker finishing exactly
      // this statement. The ceiling's only cost is how long a genuinely wedged
      // worker is given before its managed restart: while it is occupied, storage
      // already fails new work fast and the runtime keeps serving everything else.
      // Delaying a restart is recoverable; interrupting a migration is not.
      hardCeilingMs: 3_600_000,
      // Every maintenance, DDL, delete and migration path must finish one
      // chunk inside this budget. Kept a full margin below the ceiling so a
      // chunk can never be what reaches the terminal path.
      chunkBudgetMs: 30_000,
    },
    thresholds: {
      highRssBytes: 2 * 1024 * 1024 * 1024,
      highHeapUsedRatio: 0.85,
      highCpuUtilizationRatio: 0.9,
      highExternalBytes: 512 * 1024 * 1024,
      highArrayBuffersBytes: 256 * 1024 * 1024,
      eventLoopLagMs: 250,
      slowHttpRequestMs: 1000,
      slowSessionTurnMs: 30_000,
      slowLlmCallMs: 30_000,
      slowToolMs: 30_000,
      slowStorageOperationMs: 250,
      frontendPoorLcpMs: 2500,
      frontendPoorInpMs: 200,
      frontendPoorCls: 0.1,
    },
  } satisfies Info

  export function effective(input?: {
    observability?: { enabled?: boolean; maxBytes?: number; logMirror?: boolean; performance?: Raw }
  }): Info {
    const observability = input?.observability
    const raw = observability?.performance as Raw | undefined
    const enabled =
      RuntimeContext.current().host.env.SYNERGY_AGENT_WORKER !== "1" &&
      RuntimeContext.current().host.env.SYNERGY_POLICY_WORKER !== "1" &&
      (raw?.enabled ?? observability?.enabled !== false)
    return Schema.parse({
      ...defaults,
      ...raw,
      enabled,
      samplingRate: clamp(raw?.samplingRate ?? defaults.samplingRate, 0, 1),
      metricRetentionMs: clamp(raw?.metricRetentionMs ?? defaults.metricRetentionMs, 60_000, 86_400_000),
      traceRetentionMs: clamp(raw?.traceRetentionMs ?? defaults.traceRetentionMs, 60_000, 86_400_000),
      resourceSampleIntervalMs: Math.max(500, raw?.resourceSampleIntervalMs ?? defaults.resourceSampleIntervalMs),
      dashboardRefreshMs: clamp(raw?.dashboardRefreshMs ?? defaults.dashboardRefreshMs, 1000, 60_000),
      maxTimelineBuckets: clamp(raw?.maxTimelineBuckets ?? defaults.maxTimelineBuckets, 50, 1000),
      maxTraceEvents: clamp(raw?.maxTraceEvents ?? defaults.maxTraceEvents, 100, 10_000),
      maxAttributeStringLength: clamp(raw?.maxAttributeStringLength ?? defaults.maxAttributeStringLength, 64, 4096),
      redactAttributeKeys: [...new Set([...(defaults.redactAttributeKeys ?? []), ...(raw?.redactAttributeKeys ?? [])])],
      rateLimits: { ...defaults.rateLimits, ...(raw?.rateLimits ?? {}) },
      storage: {
        ...defaults.storage,
        ...(raw?.storage ?? {}),
        maxSqliteBytes: Math.max(
          1024 * 1024,
          Math.min(
            raw?.storage?.maxSqliteBytes ?? defaults.storage.maxSqliteBytes,
            observability?.maxBytes ?? defaults.storage.maxSqliteBytes,
          ),
        ),
        // Deliberately not narrowed by `observability.maxBytes`: that value caps
        // the observability database, and clamping the authoritative budget to
        // it is what made retention permanently over budget.
        retentionBytes: Math.max(1024 * 1024, raw?.storage?.retentionBytes ?? defaults.storage.retentionBytes),
        // The window bounds how far back budgeted pruning may go: below an hour
        // it would remove evidence an in-flight task still needs, and beyond 90
        // days the byte budget alone governs. 0 disables retention entirely.
        retentionMs:
          raw?.storage?.retentionMs === undefined
            ? defaults.storage.retentionMs
            : raw.storage.retentionMs <= 0
              ? 0
              : clamp(raw.storage.retentionMs, 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000),
        // The worker's ceiling is the only budget that decides the store is
        // wedged, so it holds a floor well above any legitimate statement. The
        // chunk budget is then clamped beneath it by `StorageBudgets`, leaving
        // a fixed margin that raising a chunk budget cannot consume.
        requestDeadlineMs: Math.max(1_000, raw?.storage?.requestDeadlineMs ?? defaults.storage.requestDeadlineMs),
        probeTimeoutMs: Math.max(1_000, raw?.storage?.probeTimeoutMs ?? defaults.storage.probeTimeoutMs),
        probeAttempts: Math.max(1, Math.floor(raw?.storage?.probeAttempts ?? defaults.storage.probeAttempts)),
        hardCeilingMs: Math.max(10_000, raw?.storage?.hardCeilingMs ?? defaults.storage.hardCeilingMs),
        chunkBudgetMs: Math.max(1_000, raw?.storage?.chunkBudgetMs ?? defaults.storage.chunkBudgetMs),
      },
      thresholds: { ...defaults.thresholds, ...(raw?.thresholds ?? {}) },
    })
  }

  export function isEnabled(input?: { observability?: { enabled?: boolean; maxBytes?: number; performance?: Raw } }) {
    return effective(input).enabled
  }

  function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }
}
