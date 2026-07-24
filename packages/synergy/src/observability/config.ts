import z from "zod"

export namespace ObservabilityConfig {
  let dirty = true
  let cached: Info | undefined

  export function current() {
    if (cached && !dirty) return cached
    cached = effective()
    dirty = false
    return cached
  }

  export function refresh(input?: { observability?: { enabled?: boolean; maxBytes?: number; performance?: Raw } }) {
    if (input) {
      cached = effective(input)
      dirty = false
    } else {
      dirty = true
    }
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
      walCheckpointIntervalMs?: number
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
      walCheckpointIntervalMs: z.number(),
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
      walCheckpointIntervalMs: 60_000,
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
    observability?: { enabled?: boolean; maxBytes?: number; performance?: Raw }
  }): Info {
    const observability = input?.observability
    const raw = observability?.performance as Raw | undefined
    const enabled = process.env.SYNERGY_AGENT_WORKER !== "1" && (raw?.enabled ?? observability?.enabled !== false)
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
