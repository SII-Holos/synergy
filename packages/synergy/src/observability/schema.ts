import z from "zod"

export namespace ObservabilitySchema {
  export const Source = z
    .enum(["backend", "frontend", "electron-main", "electron-renderer", "process", "browser"])
    .meta({ ref: "TelemetrySource" })
  export type Source = z.infer<typeof Source>

  export const Module = z
    .enum([
      "server",
      "session",
      "llm",
      "tool",
      "enforcement",
      "storage",
      "library",
      "process",
      "pty",
      "browser",
      "frontend",
      "desktop",
      "observability",
      "mcp",
      "plugin",
      "channel",
    ])
    .meta({ ref: "TelemetryModule" })
  export type Module = z.infer<typeof Module>

  export const Unit = z
    .enum(["ms", "bytes", "count", "ratio", "percent", "microseconds", "tokens"])
    .meta({ ref: "TelemetryUnit" })
  export type Unit = z.infer<typeof Unit>

  export const LabelValue = z
    .union([z.string().max(4096), z.number(), z.boolean(), z.null()])
    .meta({ ref: "TelemetryLabelValue" })
  export type LabelValue = z.infer<typeof LabelValue>
  export const Labels = z.record(z.string().max(96), LabelValue).default({}).meta({ ref: "TelemetryLabels" })
  export type Labels = z.infer<typeof Labels>

  export const RedactionSummary = z
    .object({ applied: z.boolean(), omittedKeys: z.number().int(), truncatedValues: z.number().int() })
    .meta({ ref: "TelemetryRedactionSummary" })
  export type RedactionSummary = z.infer<typeof RedactionSummary>

  export const Context = z
    .object({
      correlationId: z.string().optional(),
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      parentSpanId: z.string().optional(),
      rid: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      tool: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
      source: Source.optional(),
      module: Module.optional(),
    })
    .meta({ ref: "TelemetryContext" })
  export type Context = z.infer<typeof Context>

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
      redaction: RedactionSummary.default({ applied: true, omittedKeys: 0, truncatedValues: 0 }),
    })
    .meta({ ref: "TelemetryMetric" })
  export type Metric = z.infer<typeof Metric>

  export const SpanKind = z
    .enum([
      "http",
      "session",
      "session_step",
      "llm",
      "tool",
      "permission",
      "storage",
      "library",
      "frontend",
      "sse",
      "process",
      "plugin",
      "mcp",
      "channel",
      "diagnostic",
      "runtime",
    ])
    .meta({ ref: "TelemetrySpanKind" })
  export type SpanKind = z.infer<typeof SpanKind>

  export const SpanStatus = z
    .enum(["running", "ok", "error", "cancelled", "timeout"])
    .meta({ ref: "TelemetrySpanStatus" })
  export type SpanStatus = z.infer<typeof SpanStatus>

  export const Span = z
    .object({
      traceId: z.string(),
      correlationId: z.string().optional(),
      spanId: z.string(),
      parentSpanId: z.string().optional(),
      kind: SpanKind,
      name: z.string(),
      module: Module,
      source: Source,
      startTime: z.number(),
      endTime: z.number().optional(),
      durationMs: z.number().optional(),
      lastActivityTime: z.number(),
      heartbeatTime: z.number().optional(),
      heartbeatCount: z.number().int().default(0),
      stalled: z.boolean().default(false),
      status: SpanStatus.default("running"),
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
      redaction: RedactionSummary.default({ applied: true, omittedKeys: 0, truncatedValues: 0 }),
    })
    .meta({ ref: "TelemetrySpan" })
  export type Span = z.infer<typeof Span>

  export const EventLevel = z.enum(["debug", "info", "warn", "error"]).meta({ ref: "TelemetryEventLevel" })
  export type EventLevel = z.infer<typeof EventLevel>

  export const Event = z
    .object({
      eventId: z.string(),
      time: z.number(),
      iso: z.string(),
      type: z.string(),
      level: EventLevel.optional(),
      correlationId: z.string().optional(),
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      parentSpanId: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      tool: z.string().optional(),
      processId: z.string().optional(),
      pid: z.number().int().optional(),
      cwd: z.string().optional(),
      scopeID: z.string().optional(),
      rid: z.string().optional(),
      source: Source.default("backend"),
      module: Module.default("observability"),
      data: Labels.default({}),
      redaction: RedactionSummary.default({ applied: true, omittedKeys: 0, truncatedValues: 0 }),
    })
    .meta({ ref: "TelemetryEvent" })
  export type Event = z.infer<typeof Event>

  export const ServiceMemorySource = z
    .enum(["cgroup-v2", "process-sum", "unknown"])
    .meta({ ref: "TelemetryServiceMemorySource" })
  export type ServiceMemorySource = z.infer<typeof ServiceMemorySource>

  export const ServiceMemory = z
    .object({
      source: ServiceMemorySource,
      currentBytes: z.number().optional(),
      peakBytes: z.number().optional(),
      highBytes: z.number().optional(),
      maxBytes: z.number().optional(),
      usageRatio: z.number().optional(),
      swapBytes: z.number().optional(),
      anonBytes: z.number().optional(),
      fileBytes: z.number().optional(),
      kernelBytes: z.number().optional(),
      slabBytes: z.number().optional(),
      processCount: z.number().int().nonnegative(),
      rssProcessCount: z.number().int().nonnegative(),
      pssProcessCount: z.number().int().nonnegative(),
      processRssBytes: z.number().optional(),
      processPssBytes: z.number().optional(),
      events: z
        .object({
          low: z.number().int().nonnegative().optional(),
          high: z.number().int().nonnegative().optional(),
          max: z.number().int().nonnegative().optional(),
          oom: z.number().int().nonnegative().optional(),
          oomKill: z.number().int().nonnegative().optional(),
          oomGroupKill: z.number().int().nonnegative().optional(),
        })
        .default({}),
    })
    .meta({ ref: "TelemetryServiceMemory" })
  export type ServiceMemory = z.infer<typeof ServiceMemory>

  export const ResourceSample = z
    .object({
      sampleId: z.string(),
      time: z.number(),
      iso: z.string(),
      source: Source,
      correlationId: z.string().optional(),
      traceId: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      process: z.object({
        pid: z.number().int().optional(),
        processId: z.string().optional(),
        role: z.enum(["server", "tool", "service-child", "pty", "mcp", "plugin", "desktop", "browser", "unknown"]),
      }),
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
          pssBytes: z.number().optional(),
          heapTotalBytes: z.number().optional(),
          heapUsedBytes: z.number().optional(),
          externalBytes: z.number().optional(),
          arrayBuffersBytes: z.number().optional(),
        })
        .default({}),
      serviceMemory: ServiceMemory.optional(),
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
      labels: Labels,
      redaction: RedactionSummary.default({ applied: true, omittedKeys: 0, truncatedValues: 0 }),
    })
    .meta({ ref: "TelemetryResourceSample" })
  export type ResourceSample = z.infer<typeof ResourceSample>

  export const IssueSeverity = z.enum(["info", "warning", "error", "critical"]).meta({ ref: "TelemetryIssueSeverity" })
  export const IssueStatus = z.enum(["open", "resolved", "suppressed"]).meta({ ref: "TelemetryIssueStatus" })
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
      traceId: z.string().optional(),
      spanId: z.string().optional(),
      scopeID: z.string().optional(),
      sessionID: z.string().optional(),
      messageID: z.string().optional(),
      callID: z.string().optional(),
      rid: z.string().optional(),
      evidence: Labels,
      firstSeenTime: z.number(),
      lastSeenTime: z.number(),
      occurrenceCount: z.number().int(),
      fingerprint: z.string(),
      redaction: RedactionSummary.default({ applied: true, omittedKeys: 0, truncatedValues: 0 }),
    })
    .meta({ ref: "TelemetryIssue" })
  export type Issue = z.infer<typeof Issue>

  export const InflightSpan = Span.extend({
    ageMs: z.number(),
    idleMs: z.number(),
    stale: z.boolean(),
  }).meta({ ref: "TelemetryInflightSpan" })
  export type InflightSpan = z.infer<typeof InflightSpan>

  export const Query = z
    .object({
      traceId: z.string().optional(),
      correlationId: z.string().optional(),
      sessionID: z.string().optional(),
      callID: z.string().optional(),
      since: z.number().optional(),
      until: z.number().optional(),
      limit: z.number().int().positive().optional(),
      level: EventLevel.optional(),
      type: z.string().optional(),
    })
    .meta({ ref: "TelemetryQuery" })
  export type Query = z.infer<typeof Query>

  export const DiagnosticsSummary = z
    .object({
      generatedAt: z.string(),
      logs: z.object({
        current: z.string().optional(),
        dev: z.string().optional(),
        daemon: z.string().optional(),
        devArchives: z.array(z.string()),
      }),
      traces: z.object({ directory: z.string(), files: z.array(z.string()), recentErrors: z.array(Event) }),
      issues: z.array(Issue),
      inflight: z.array(InflightSpan),
      resources: z.object({
        latest: ResourceSample.optional(),
        samples: z.array(ResourceSample),
        pressure: Labels.default({}),
      }),
      lock: z.object({ path: z.string(), lock: z.unknown().optional(), inspection: z.unknown().optional() }).optional(),
      processes: z.object({
        active: z.array(z.record(z.string(), z.unknown())),
        finished: z.array(z.record(z.string(), z.unknown())),
      }),
      sessions: z.object({
        pendingReply: z.array(z.object({ sessionID: z.string(), path: z.string(), updated: z.number().optional() })),
      }),
    })
    .meta({ ref: "DiagnosticsSummary" })
  export type DiagnosticsSummary = z.infer<typeof DiagnosticsSummary>
}
