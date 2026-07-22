/** Runtime Lingui descriptors for performance host labels and wrappers.
 *  Translate at use time via `useLingui()._(descriptor)`. */

export const P = {
  // panel.tsx
  panelTitle: { id: "app.performance.panel.title", message: "Performance" },
  panelSubtitle: {
    id: "app.performance.panel.subtitle",
    message: "Live runtime resource usage, trace latency, browser metrics, and performance issues.",
  },

  // PerformanceDashboard.tsx
  snapshotLabel: { id: "app.performance.snapshot.label", message: "Performance snapshot" },
  snapshotFrom: { id: "app.performance.snapshot.from", message: "Snapshot from {time}" },
  refresh: { id: "app.performance.action.refresh", message: "Refresh" },

  // performance analysis
  analysisAnalyze: { id: "app.performance.analysis.action.analyze", message: "Analyze" },
  analysisAnalyzing: { id: "app.performance.analysis.action.analyzing", message: "Analyzing…" },
  analysisCancel: { id: "app.performance.analysis.action.cancel", message: "Cancel" },
  analysisOpenSession: { id: "app.performance.analysis.action.openSession", message: "Open session" },
  analysisTitle: { id: "app.performance.analysis.title", message: "AI performance analysis" },
  analysisDescriptionReady: {
    id: "app.performance.analysis.description.ready",
    message: "Bounded, redacted telemetry analyzed in one durable Session",
  },
  analysisDescriptionPreparing: {
    id: "app.performance.analysis.description.preparing",
    message: "Preparing a bounded, redacted telemetry snapshot",
  },
  analysisProgress: {
    id: "app.performance.analysis.progress",
    message: "The analyst is correlating current health, latency, resource, session, storage, and frontend signals.",
  },
  analysisStatusQueued: { id: "app.performance.analysis.status.queued", message: "Queued" },
  analysisStatusRunning: { id: "app.performance.analysis.status.running", message: "Running" },
  analysisStatusCompleted: { id: "app.performance.analysis.status.completed", message: "Completed" },
  analysisStatusFailed: { id: "app.performance.analysis.status.failed", message: "Failed" },
  analysisStatusCancelled: { id: "app.performance.analysis.status.cancelled", message: "Cancelled" },
  analysisStatusInterrupted: { id: "app.performance.analysis.status.interrupted", message: "Interrupted" },

  // summary cards
  summaryHealth: { id: "app.performance.summary.health", message: "Health" },
  summaryUnknown: { id: "app.performance.summary.unknown", message: "Unknown" },
  summaryHttpP95: { id: "app.performance.summary.httpP95", message: "HTTP p95" },
  summarySessions: { id: "app.performance.summary.sessions", message: "Sessions" },
  summarySessionsValue: { id: "app.performance.summary.sessionsValue", message: "{active} active · {pending} pending" },
  summaryIssues: { id: "app.performance.summary.issues", message: "Issues" },
  summaryCpu: { id: "app.performance.summary.cpu", message: "CPU" },
  summaryMemory: { id: "app.performance.summary.memory", message: "Memory" },
  summaryServiceMemory: { id: "app.performance.summary.serviceMemory", message: "Service memory" },
  summaryMainRss: { id: "app.performance.summary.mainRss", message: "Main process RSS" },
  summaryHeapUsed: { id: "app.performance.summary.heapUsed", message: "Heap used" },
  summaryExternal: { id: "app.performance.summary.external", message: "External" },
  summaryArrayBuffers: { id: "app.performance.summary.arrayBuffers", message: "ArrayBuffers" },
  summaryToolChildRss: { id: "app.performance.summary.toolChildRss", message: "Tool child RSS" },
  summaryToolChildRssValue: { id: "app.performance.summary.toolChildRssValue", message: "{rss} · {count} active" },
  summaryServiceChildMemory: {
    id: "app.performance.summary.serviceChildMemory",
    message: "Service child memory",
  },
  summaryServiceChildMemoryValue: {
    id: "app.performance.summary.serviceChildMemoryValue",
    message: "{rss} RSS · {pss} PSS · {count} active",
  },
  summaryEventLoop: { id: "app.performance.summary.eventLoop", message: "Event loop p95" },
  summaryDiskIo: { id: "app.performance.summary.diskIo", message: "Disk IO" },
  summaryDiskIoValue: { id: "app.performance.summary.diskIoValue", message: "{read} read · {write} write" },
  summaryDiskOps: { id: "app.performance.summary.diskOps", message: "Disk ops" },
  summaryDiskOpsValue: { id: "app.performance.summary.diskOpsValue", message: "{read} read · {write} write" },
  summaryLlmCalls: { id: "app.performance.summary.llmCalls", message: "LLM calls" },
  summaryToolCalls: { id: "app.performance.summary.toolCalls", message: "Tool calls" },
  summaryLongTasks: { id: "app.performance.summary.longTasks", message: "Long tasks" },

  serviceMemoryTitle: { id: "app.performance.serviceMemory.title", message: "Service memory attribution" },
  serviceMemoryDesc: {
    id: "app.performance.serviceMemory.desc",
    message: "Linux cgroup v2 totals and process attribution for the complete Synergy service.",
  },
  serviceMemorySource: { id: "app.performance.serviceMemory.source", message: "Source" },
  serviceMemoryCurrent: { id: "app.performance.serviceMemory.current", message: "Current" },
  serviceMemoryPeak: { id: "app.performance.serviceMemory.peak", message: "Peak" },
  serviceMemoryHigh: { id: "app.performance.serviceMemory.high", message: "High threshold" },
  serviceMemoryMax: { id: "app.performance.serviceMemory.max", message: "Maximum" },
  serviceMemoryAnon: { id: "app.performance.serviceMemory.anon", message: "Anonymous" },
  serviceMemoryFile: { id: "app.performance.serviceMemory.file", message: "File cache" },
  serviceMemoryKernel: { id: "app.performance.serviceMemory.kernel", message: "Kernel" },
  serviceMemorySlab: { id: "app.performance.serviceMemory.slab", message: "Slab" },
  serviceMemorySwap: { id: "app.performance.serviceMemory.swap", message: "Swap" },
  serviceMemoryProcessRss: { id: "app.performance.serviceMemory.processRss", message: "Process RSS" },
  serviceMemoryProcessPss: { id: "app.performance.serviceMemory.processPss", message: "Process PSS" },
  serviceMemoryEvents: { id: "app.performance.serviceMemory.events", message: "Pressure events" },
  serviceMemoryCoverage: {
    id: "app.performance.serviceMemory.coverage",
    message: "{value} · {covered}/{total} processes",
  },
  serviceMemoryEventsValue: {
    id: "app.performance.serviceMemory.eventsValue",
    message: "high {high} · max {max} · OOM {oom} · killed {oomKill}",
  },

  // runtime support
  runtimeHealth: { id: "app.performance.runtime.health", message: "Runtime health and support" },
  runtimeHealthDesc: {
    id: "app.performance.runtime.healthDesc",
    message:
      "Diagnostics-derived support signals for lock health, trace evidence, session runtimes, and retained tasks.",
  },
  runtimeLock: { id: "app.performance.runtime.lock", message: "Runtime lock" },
  runtimeMirrorFiles: { id: "app.performance.runtime.mirrorFiles", message: "Mirror files" },
  runtimeRecentErrors: { id: "app.performance.runtime.recentErrors", message: "Recent errors" },
  runtimePendingSessions: { id: "app.performance.runtime.pendingSessions", message: "Pending sessions" },
  runtimeSessionRuntimes: { id: "app.performance.runtime.sessionRuntimes", message: "Session runtimes" },
  runtimeCortexTasks: { id: "app.performance.runtime.cortexTasks", message: "Cortex tasks" },
  runtimeMessageCache: { id: "app.performance.runtime.messageCache", message: "Message cache" },
  runtimeLlmStreams: { id: "app.performance.runtime.llmStreams", message: "LLM streams" },
  runtimeUnknown: { id: "app.performance.runtime.unknown", message: "Unknown" },
  runtimeAlive: { id: "app.performance.runtime.alive", message: "Alive" },
  runtimeNotRunning: { id: "app.performance.runtime.notRunning", message: "Not running" },
  runtimeHealthy: { id: "app.performance.runtime.healthy", message: "healthy" },
  runtimeNeedsAttention: { id: "app.performance.runtime.needsAttention", message: "needs attention" },

  // runtime support values
  runtimeLockStateUnknown: { id: "app.performance.runtime.lockStateUnknown", message: "Unknown" },
  runtimeLockStateAlive: { id: "app.performance.runtime.lockStateAlive", message: "Alive" },
  runtimeLockStateNotRunning: { id: "app.performance.runtime.lockStateNotRunning", message: "Not running" },
  runtimeHealthStateUnknown: { id: "app.performance.runtime.healthStateUnknown", message: "unknown" },
  runtimeMirrorFilesValue: { id: "app.performance.runtime.mirrorFilesValue", message: "{count} files" },
  runtimeSessionRuntimesValue: {
    id: "app.performance.runtime.sessionRuntimesValue",
    message: "{total} total · {running} running",
  },
  runtimeCortexTasksValue: {
    id: "app.performance.runtime.cortexTasksValue",
    message: "{total} retained · {running} running",
  },
  runtimeMessageCacheValue: {
    id: "app.performance.runtime.messageCacheValue",
    message:
      "{bytes} · {entries} entries ({active} active) · {hits}/{misses} hit/miss · {evictions} evictions · {protected} protected over budget · largest {largest}",
  },
  runtimeLlmStreamsValue: {
    id: "app.performance.runtime.llmStreamsValue",
    message: "{streams} streams · {turns} turns",
  },

  // chart descriptions
  chartCpu: { id: "app.performance.chart.cpu.title", message: "CPU and event loop" },
  chartCpuDesc: {
    id: "app.performance.chart.cpu.desc",
    message: "CPU average percent and event-loop p95 latency from runtime timeline buckets",
  },
  chartMemory: { id: "app.performance.chart.memory.title", message: "Memory" },
  chartMemoryDesc: {
    id: "app.performance.chart.memory.desc",
    message: "RSS, heap, external, and ArrayBuffer memory gauges in MB",
  },
  chartServiceMemoryDesc: {
    id: "app.performance.chart.memory.serviceDesc",
    message: "Service total, main-process RSS, heap, external, and ArrayBuffer memory gauges in MB",
  },
  datasetServiceMemory: { id: "app.performance.dataset.serviceMemory", message: "Service total" },
  datasetRss: { id: "app.performance.dataset.rss", message: "RSS" },
  datasetHeapUsed: { id: "app.performance.dataset.heapUsed", message: "Heap used" },
  datasetHeapTotal: { id: "app.performance.dataset.heapTotal", message: "Heap total" },
  datasetExternal: { id: "app.performance.dataset.external", message: "External" },
  datasetArrayBuffers: { id: "app.performance.dataset.arrayBuffers", message: "ArrayBuffers" },
  chartRequests: { id: "app.performance.chart.requests.title", message: "Requests" },
  chartRequestsDesc: {
    id: "app.performance.chart.requests.desc",
    message: "HTTP request p95 latency with request sample count per bucket",
  },
  chartSessions: { id: "app.performance.chart.sessions.title", message: "Sessions" },
  chartSessionsDesc: {
    id: "app.performance.chart.sessions.desc",
    message: "Only real session timeline metrics are shown; current active sessions remain in summary cards",
  },
  chartSessionsEmpty: {
    id: "app.performance.chart.sessions.empty",
    message: "No historical session samples for this range",
  },
  chartStorage: { id: "app.performance.chart.storage.title", message: "Storage I/O" },
  chartStorageDesc: {
    id: "app.performance.chart.storage.desc",
    message: "Storage operation counts and p95 latency from emitted storage metrics",
  },
  chartStorageEmpty: {
    id: "app.performance.chart.storage.empty",
    message: "Storage metrics are not available for this range",
  },
  chartBrowser: { id: "app.performance.chart.browser.title", message: "Local browser samples" },
  chartBrowserDesc: {
    id: "app.performance.chart.browser.desc",
    message:
      "Local DOM, navigation, and heap samples collected by this Performance view, separate from stored frontend telemetry",
  },
  chartBrowserMemoryUnsupported: {
    id: "app.performance.chart.browser.memoryUnsupported",
    message: "Browser memory API is unavailable in this browser.",
  },
  chartNoSamples: { id: "app.performance.chart.noSamples", message: "No samples yet" },

  // chart quality messages
  qualityPartial: {
    id: "app.performance.quality.partial",
    message: "Timeline data is partial because the metric volume exceeded the dashboard cap.",
  },
  qualityUnavailable: {
    id: "app.performance.quality.unavailable",
    message: "Metrics are not available for this range.",
  },
  qualityRetention: {
    id: "app.performance.quality.retention",
    message: "Timeline data is retention-limited for this range.",
  },
  qualitySummaryPartial: {
    id: "app.performance.quality.summaryPartial",
    message: "Summary is partial because the metric volume exceeded the dashboard cap.",
  },

  // axis titles
  axisPercent: { id: "app.performance.axis.percent", message: "Percent" },
  axisMilliseconds: { id: "app.performance.axis.milliseconds", message: "Milliseconds" },
  axisMemory: { id: "app.performance.axis.memory", message: "Memory (MB)" },
  axisCount: { id: "app.performance.axis.count", message: "Count" },
  axisBytes: { id: "app.performance.axis.bytes", message: "Bytes" },

  // traces and issues
  traceTimeline: { id: "app.performance.timeline.title", message: "Recent event traces" },
  traceNoTraces: { id: "app.performance.timeline.noTraces", message: "No recent traces" },
  timelineTitle: { id: "app.performance.timeline.componentTitle", message: "Trace timeline" },
  timelineNoSpans: { id: "app.performance.timeline.noSpans", message: "No trace spans reported" },
  issuesTitle: { id: "app.performance.issues.title", message: "Performance issues" },
  issuesNoIssues: { id: "app.performance.issues.noIssues", message: "No recent issues" },
  issuesNoActive: { id: "app.performance.issues.noActive", message: "No active performance issues" },
  issuesFallbackName: { id: "app.performance.issues.fallbackName", message: "Performance issue" },
  severityInfo: { id: "app.performance.severity.info", message: "info" },
  issueTraceAvailable: {
    id: "app.performance.issue.traceAvailable",
    message: "trace available",
  },
  toolFailures: { id: "app.performance.toolFailures.title", message: "Tool failures" },
  toolFailuresDesc: {
    id: "app.performance.toolFailures.desc",
    message: "Failures, call volume, and error categories in the selected range",
  },
  toolFailuresEmpty: {
    id: "app.performance.toolFailures.empty",
    message: "No tool failures in this range",
  },
  toolFailuresFailed: { id: "app.performance.toolFailures.failed", message: "failed" },
  toolFailuresCalls: { id: "app.performance.toolFailures.calls", message: "calls" },
  toolFailuresNone: {
    id: "app.performance.toolFailures.none",
    message: "No error category reported",
  },
  topRankings: { id: "app.performance.topRankings.title", message: "Top rankings" },
  rankingSlowRoutes: { id: "app.performance.ranking.slowRoutes", message: "Slow routes" },
  rankingSlowSessions: { id: "app.performance.ranking.slowSessions", message: "Slow sessions" },
  rankingSlowTools: { id: "app.performance.ranking.slowTools", message: "Slow tools" },
  rankingSlowProviders: { id: "app.performance.ranking.slowProviders", message: "Slow providers" },
  rankingSlowStorage: { id: "app.performance.ranking.slowStorage", message: "Slow storage" },
  rankingSlowLibrary: { id: "app.performance.ranking.slowLibrary", message: "Slow library" },
  rankingChildProcess: { id: "app.performance.ranking.childProcess", message: "Child process RSS" },
  rankingEmpty: {
    id: "app.performance.ranking.empty",
    message: "No {title} results for this range",
  },

  // frontend
  frontendSlow: { id: "app.performance.frontend.slow", message: "Slow frontend" },
  frontendVitals: { id: "app.performance.frontend.vitals", message: "Frontend vitals" },
  frontendNoSlow: { id: "app.performance.frontend.noSlow", message: "No slow frontend routes in this range" },
  frontendResourceP95: { id: "app.performance.frontend.resourceP95", message: "Resource p95" },

  // trace drawer
  traceDetail: { id: "app.performance.trace.title", message: "Trace Detail" },
  traceStatus: { id: "app.performance.trace.status", message: "Status" },
  traceDuration: { id: "app.performance.trace.duration", message: "Duration" },
  traceModule: { id: "app.performance.trace.module", message: "Module" },
  traceSession: { id: "app.performance.trace.session", message: "Session" },
  traceStart: { id: "app.performance.trace.start", message: "Start" },
  traceEnd: { id: "app.performance.trace.end", message: "End" },
  traceSpans: { id: "app.performance.trace.spans", message: "Spans" },
  traceEvents: { id: "app.performance.trace.events", message: "Events" },
  traceUnknown: { id: "app.performance.trace.unknown", message: "unknown" },

  // use-performance.ts
  loadError: { id: "app.performance.error.load", message: "Unable to load performance data right now." },

  // time ranges
  timeRange15m: { id: "app.performance.timeRange.15m", message: "15m" },
  timeRange1h: { id: "app.performance.timeRange.1h", message: "1h" },
  timeRange6h: { id: "app.performance.timeRange.6h", message: "6h" },
  timeRange24h: { id: "app.performance.timeRange.24h", message: "24h" },

  // empty states
  emptyLabel: { id: "app.performance.empty.default", message: "No data available" },
}
