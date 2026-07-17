import { ObservabilityConfig } from "@/observability/config"
import { ObservabilitySchema } from "@/observability/schema"
import z from "zod"

export namespace PerformanceSchema {
  export const Source = ObservabilitySchema.Source.meta({ ref: "PerfSource" })
  export type Source = z.infer<typeof Source>

  export const Module = ObservabilitySchema.Module.meta({ ref: "PerfModule" })
  export type Module = z.infer<typeof Module>

  export const Unit = ObservabilitySchema.Unit.meta({ ref: "PerfUnit" })
  export type Unit = z.infer<typeof Unit>

  export const LabelValue = ObservabilitySchema.LabelValue.meta({ ref: "PerfLabelValue" })
  export type LabelValue = z.infer<typeof LabelValue>
  export const Labels = ObservabilitySchema.Labels.meta({ ref: "PerfLabels" })
  export type Labels = z.infer<typeof Labels>

  export const Metric = z
    .object({
      metricId: z.string(),
      time: z.number(),
      iso: z.string(),
      name: z.string(),
      value: z.number(),
      unit: Unit,
      source: Source,
      module: Module,
      correlationId: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      parentSpanId: z.string().optional(),
      rid: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
      tool: z.string().optional(),
      labels: Labels,
      sampleRate: z.number().min(0).max(1).default(1),
    })
    .meta({ ref: "PerfMetric" })
  export type Metric = z.infer<typeof Metric>

  export const SpanStatus = z.enum(["running", "ok", "error", "cancelled", "timeout"]).meta({ ref: "PerfSpanStatus" })
  export type SpanStatus = z.infer<typeof SpanStatus>
  export const Span = z
    .object({
      traceId: z.string(),
      correlationId: z.string().optional(),
      spanId: z.string(),
      parentSpanId: z.string().optional(),
      kind: z.string().optional(),
      name: z.string(),
      module: Module,
      source: Source,
      startTime: z.number(),
      endTime: z.number().optional(),
      durationMs: z.number().optional(),
      status: SpanStatus.default("ok"),
      lastActivityTime: z.number().optional(),
      heartbeatTime: z.number().optional(),
      heartbeatCount: z.number().int().optional(),
      stalled: z.boolean().optional(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      rid: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
      tool: z.string().optional(),
      attributes: Labels,
    })
    .meta({ ref: "PerfSpan" })

  export const ResourceSample = z
    .object({
      sampleId: z.string(),
      time: z.number(),
      iso: z.string(),
      source: Source,
      process: z.object({ pid: z.number().int().optional(), processId: z.string().optional(), role: z.string() }),
      cpu: z
        .object({
          userMicros: z.number().optional(),
          systemMicros: z.number().optional(),
          utilizationRatio: z.number().optional(),
        })
        .default({}),
      memory: z
        .object({
          rssBytes: z.number().optional(),
          heapTotalBytes: z.number().optional(),
          heapUsedBytes: z.number().optional(),
          externalBytes: z.number().optional(),
          arrayBuffersBytes: z.number().optional(),
        })
        .default({}),
      eventLoop: z.object({ lagMs: z.number().optional(), sampleWindowMs: z.number() }),
      io: z
        .object({
          appReadBytes: z.number().optional(),
          appWrittenBytes: z.number().optional(),
          appReadOps: z.number().optional(),
          appWriteOps: z.number().optional(),
          osReadBytes: z.number().optional(),
          osWrittenBytes: z.number().optional(),
          osAvailable: z.boolean().default(false),
        })
        .default({ osAvailable: false }),
      correlationId: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      traceId: z.string().optional(),
      labels: Labels,
    })
    .meta({ ref: "PerfResourceSample" })
  export type ResourceSample = z.infer<typeof ResourceSample>

  export const IssueSeverity = z.enum(["info", "warning", "error", "critical"]).meta({ ref: "PerfIssueSeverity" })
  export const IssueStatus = z.enum(["open", "resolved", "suppressed"]).meta({ ref: "PerfIssueStatus" })
  export type IssueSeverity = z.infer<typeof IssueSeverity>
  export type IssueStatus = z.infer<typeof IssueStatus>
  export const Issue = z
    .object({
      issueId: z.string(),
      time: z.number(),
      iso: z.string(),
      severity: IssueSeverity,
      status: IssueStatus.default("open"),
      code: z.string(),
      title: z.string(),
      message: z.string(),
      recommendation: z.string().optional(),
      module: Module,
      correlationId: z.string().optional(),
      scopeID: z.string().optional(),
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      rid: z.string().optional(),
      evidence: Labels,
      firstSeenTime: z.number(),
      lastSeenTime: z.number(),
      occurrenceCount: z.number().int(),
      fingerprint: z.string(),
    })
    .meta({ ref: "PerfIssue" })
  export type Issue = z.infer<typeof Issue>

  export const RankedItem = z
    .object({
      id: z.string(),
      label: z.string(),
      module: Module.optional(),
      value: z.number(),
      unit: Unit,
      traceId: z.string().optional(),
      sessionID: z.string().optional(),
      tool: z.string().optional(),
      status: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
    })
    .meta({ ref: "PerfRankedItem" })
  export type RankedItem = z.infer<typeof RankedItem>

  export const ToolFailureCategory = z
    .object({
      errorClass: z.string(),
      count: z.number().int().nonnegative(),
    })
    .meta({ ref: "PerfToolFailureCategory" })
  export type ToolFailureCategory = z.infer<typeof ToolFailureCategory>

  export const ToolFailureItem = z
    .object({
      tool: z.string(),
      callCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
      errorRate: z.number().min(0).max(1),
      categories: z.array(ToolFailureCategory),
    })
    .meta({ ref: "PerfToolFailureItem" })
  export type ToolFailureItem = z.infer<typeof ToolFailureItem>

  export const TimelineQuality = z
    .object({
      truncated: z.boolean().optional(),
      sampled: z.boolean().optional(),
      partial: z.boolean().optional(),
      retentionLimited: z.boolean().optional(),
      unavailableReason: z.string().optional(),
    })
    .meta({ ref: "PerfTimelineQuality" })

  export const DashboardSummary = z
    .object({
      generatedAt: z.string(),
      windowMs: z.number(),
      quality: TimelineQuality.optional(),
      health: z.object({
        status: z.enum(["healthy", "degraded", "critical", "unknown"]),
        score: z.number(),
        openIssueCount: z.number().int(),
        criticalIssueCount: z.number().int(),
      }),
      backend: z.object({
        requestCount: z.number().int(),
        errorRate: z.number(),
        p50RequestMs: z.number().optional(),
        p95RequestMs: z.number().optional(),
        p99RequestMs: z.number().optional(),
        activeSessions: z.number().int(),
        pendingSessions: z.number().int(),
      }),
      resources: z.object({
        rssBytes: z.number().optional(),
        heapUsedBytes: z.number().optional(),
        heapTotalBytes: z.number().optional(),
        cpuUtilizationRatio: z.number().optional(),
        eventLoopLagP95Ms: z.number().optional(),
        appReadBytes: z.number().optional(),
        appWrittenBytes: z.number().optional(),
        appReadOps: z.number().int().optional(),
        appWriteOps: z.number().int().optional(),
        childProcessCount: z.number().int().optional(),
        childProcessRssBytes: z.number().optional(),
      }),
      sessions: z.object({
        turnCount: z.number().int(),
        p95TurnMs: z.number().optional(),
        llmCallCount: z.number().int(),
        toolCallCount: z.number().int(),
      }),
      frontend: z.object({
        inpMs: z.number().optional(),
        lcpMs: z.number().optional(),
        cls: z.number().optional(),
        fcpMs: z.number().optional(),
        ttfbMs: z.number().optional(),
        longTaskCount: z.number().int(),
        resourceP95Ms: z.number().optional(),
      }),
      runtime: z.object({
        alive: z.boolean().optional(),
        healthy: z.boolean().optional(),
        pid: z.number().int().optional(),
        mode: z.string().optional(),
        mirrorFiles: z.number().int(),
        traceFiles: z.number().int().optional(),
        recentErrors: z.number().int(),
        pendingSessions: z.number().int(),
        sessionRuntimes: z.object({
          totalCount: z.number().int(),
          runningCount: z.number().int(),
          idleCount: z.number().int(),
          childCount: z.number().int(),
          userCount: z.number().int(),
          waiterCount: z.number().int(),
        }),
        cortexTasks: z.object({
          totalCount: z.number().int(),
          queuedCount: z.number().int(),
          runningCount: z.number().int(),
          completedCount: z.number().int(),
          errorCount: z.number().int(),
          cancelledCount: z.number().int(),
          interruptedCount: z.number().int(),
          retainedPromptChars: z.number().int(),
          retainedOutputChars: z.number().int(),
          retainedErrorChars: z.number().int(),
          retainedProgressToolCount: z.number().int(),
        }),
      }),
      top: z.object({
        slowRoutes: z.array(RankedItem),
        slowSessions: z.array(RankedItem),
        slowTools: z.array(RankedItem),
        toolFailures: z.array(ToolFailureItem),
        slowProviders: z.array(RankedItem),
        slowStorage: z.array(RankedItem),
        slowLibrary: z.array(RankedItem),
        childProcesses: z.array(RankedItem),
        slowFrontend: z.array(RankedItem),
      }),
      issues: z.array(Issue),
    })
    .meta({ ref: "PerfDashboardSummary" })
  export type DashboardSummary = z.infer<typeof DashboardSummary>

  export const TimelineQuery = z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      bucketMs: z.coerce.number().int().positive().optional(),
      metric: z.union([z.string(), z.array(z.string())]).optional(),
      stat: z.enum(["avg", "latest", "sum", "rate", "p50", "p95", "p99", "max"]).optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      tool: z.string().optional(),
      providerID: z.string().optional(),
      module: Module.optional(),
      windowMs: z.coerce.number().int().positive().optional(),
    })
    .meta({ ref: "PerfTimelineQuery" })
  export type TimelineQuery = z.infer<typeof TimelineQuery>

  export const TimelineStat = z
    .enum(["avg", "latest", "sum", "rate", "p50", "p95", "p99", "max"])
    .meta({ ref: "PerfTimelineStat" })
  export const MetricKind = z
    .enum(["duration", "gauge", "counter", "rate", "size", "ratio"])
    .meta({ ref: "PerfMetricKind" })
  export const TimelinePoint = z
    .object({ time: z.number(), value: z.number().nullable(), sampleCount: z.number().int().optional() })
    .meta({ ref: "PerfTimelinePoint" })
  export const TimelineSeries = z
    .object({
      name: z.string(),
      label: z.string().optional(),
      unit: Unit,
      kind: MetricKind.optional(),
      stat: TimelineStat.optional(),
      sampleCount: z.number().int().optional(),
      module: Module.optional(),
      source: Source.optional(),
      quality: TimelineQuality.optional(),
      points: z.array(TimelinePoint),
    })
    .meta({ ref: "PerfTimelineSeries" })
  export const Timeline = z
    .object({
      generatedAt: z.string(),
      from: z.number(),
      to: z.number(),
      bucketMs: z.number(),
      quality: TimelineQuality.optional(),
      series: z.array(TimelineSeries),
    })
    .meta({ ref: "PerfTimeline" })
  export type Timeline = z.infer<typeof Timeline>

  export const TraceListQuery = z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
      kind: z
        .enum(["request", "session", "tool", "provider", "runtime", "storage", "frontend", "mcp", "plugin", "channel"])
        .optional(),
      status: SpanStatus.optional(),
      minDurationMs: z.coerce.number().nonnegative().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
    })
    .meta({ ref: "PerfTraceListQuery" })
  export type TraceListQuery = z.infer<typeof TraceListQuery>

  export const TraceListItem = z
    .object({
      traceId: z.string(),
      correlationId: z.string().optional(),
      kind: z.string(),
      name: z.string(),
      status: SpanStatus,
      startedAt: z.string(),
      endedAt: z.string().optional(),
      durationMs: z.number().optional(),
      module: Module,
      source: Source,
      sessionID: z.string().optional(),
      scopeID: z.string().optional(),
      rid: z.string().optional(),
      tool: z.string().optional(),
      errorCode: z.string().optional(),
      redactionApplied: z.boolean(),
    })
    .meta({ ref: "PerfTraceListItem" })
  export type TraceListItem = z.infer<typeof TraceListItem>

  export const TraceList = z
    .object({ generatedAt: z.string(), items: z.array(TraceListItem), nextCursor: z.string().optional() })
    .meta({ ref: "PerfTraceList" })
  export type TraceList = z.infer<typeof TraceList>

  export const InflightSpan = Span.extend({
    ageMs: z.number(),
    idleMs: z.number(),
    stale: z.boolean(),
  }).meta({ ref: "PerfInflightSpan" })
  export type InflightSpan = z.infer<typeof InflightSpan>

  export const Inflight = z
    .object({ generatedAt: z.string(), spans: z.array(InflightSpan) })
    .meta({ ref: "PerfInflight" })
  export type Inflight = z.infer<typeof Inflight>

  export const AnalysisRequest = z
    .object({
      windowMs: z.coerce.number().int().min(1000).max(86_400_000).default(900_000),
    })
    .meta({ ref: "PerformanceAnalysisRequest" })
  export type AnalysisRequest = z.infer<typeof AnalysisRequest>

  export const AnalysisStatus = z
    .enum(["queued", "running", "completed", "error", "cancelled", "interrupted"])
    .meta({ ref: "PerformanceAnalysisStatus" })
  export type AnalysisStatus = z.infer<typeof AnalysisStatus>

  export const AnalysisView = z
    .object({
      sessionID: z.string(),
      status: AnalysisStatus,
      startedAt: z.number(),
      completedAt: z.number().optional(),
      result: z.string().optional(),
      error: z.string().optional(),
    })
    .meta({ ref: "PerformanceAnalysisView" })
  export type AnalysisView = z.infer<typeof AnalysisView>

  export const TraceEvent = z
    .object({
      time: z.number(),
      iso: z.string(),
      type: z.string(),
      level: z.string().optional(),
      traceId: z.string().optional(),
      correlationId: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      rid: z.string().optional(),
      tool: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
      dataKeys: z.array(z.string()).default([]),
      redactionApplied: z.boolean(),
    })
    .meta({ ref: "PerfTraceEvent" })
  export type TraceEvent = z.infer<typeof TraceEvent>

  export const TraceDetail = z
    .object({
      generatedAt: z.string(),
      traceId: z.string(),
      root: Span.optional(),
      spans: z.array(Span),
      events: z.array(TraceEvent),
      redaction: z.object({ applied: z.boolean(), omittedAttributes: z.number().int() }),
    })
    .meta({ ref: "PerfTraceDetail" })
  export type TraceDetail = z.infer<typeof TraceDetail>

  export const BrowserMetric = z
    .object({
      name: z.string().max(96),
      value: z.number(),
      unit: Unit,
      time: z.number().optional(),
      labels: Labels.optional(),
    })
    .meta({ ref: "PerfBrowserMetric" })
  export type BrowserMetric = z.infer<typeof BrowserMetric>

  export const BrowserMetricBatch = z
    .object({
      batchId: z.string().max(128).optional(),
      sentAt: z.number(),
      page: z
        .object({
          routeName: z.string().max(256).optional(),
          pathTemplate: z.string().max(512).optional(),
          sessionID: z.string().max(128).optional(),
          scopeID: z.string().max(128).optional(),
          correlationId: z.string().max(128).optional(),
          navigationId: z.string().max(128).optional(),
          sessionSwitchId: z.string().max(128).optional(),
        })
        .default({}),
      metrics: z.array(BrowserMetric).max(100),
      resourceEntries: z
        .array(
          z.object({
            name: z.string().max(2048),
            initiatorType: z.string().max(64).optional(),
            startTime: z.number(),
            duration: z.number(),
            transferSize: z.number().optional(),
            encodedBodySize: z.number().optional(),
            decodedBodySize: z.number().optional(),
          }),
        )
        .max(100)
        .optional(),
      longTasks: z
        .array(z.object({ startTime: z.number(), duration: z.number(), attribution: z.string().max(128).optional() }))
        .max(100)
        .optional(),
    })
    .meta({ ref: "PerfBrowserMetricBatch" })
  export type BrowserMetricBatch = z.infer<typeof BrowserMetricBatch>

  export const BrowserMetricIngestResult = z
    .object({ batchId: z.string(), accepted: z.number().int(), rejected: z.number().int(), receivedAt: z.string() })
    .meta({ ref: "PerfBrowserMetricIngestResult" })
  export type BrowserMetricIngestResult = z.infer<typeof BrowserMetricIngestResult>

  export const Config = ObservabilityConfig.Schema.meta({ ref: "PerfConfig" })
  export type Config = z.infer<typeof Config>
}
