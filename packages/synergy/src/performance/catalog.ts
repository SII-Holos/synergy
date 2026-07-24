import { PerformanceSchema } from "./schema"

export namespace PerformanceCatalog {
  export const Stat = ["avg", "latest", "sum", "rate", "p50", "p95", "p99", "max"] as const
  export type Stat = (typeof Stat)[number]

  export const Kind = ["duration", "gauge", "counter", "rate", "size", "ratio"] as const
  export type Kind = (typeof Kind)[number]

  export interface MetricInfo {
    name: string
    label: string
    unit: PerformanceSchema.Unit
    kind: Kind
    defaultStat: Stat
    module: PerformanceSchema.Module
    source: PerformanceSchema.Source
    labels: string[]
    status: "emitted" | "derived" | "internal"
    aliases?: string[]
  }

  const metricList = [
    metric("http.request.duration", "HTTP request latency", "ms", "duration", "p95", "server", "backend", [
      "method",
      "path",
      "status",
    ]),
    metric("http.request.size", "HTTP request size", "bytes", "size", "avg", "server", "backend", ["method", "path"]),
    metric("http.response.size", "HTTP response size", "bytes", "size", "avg", "server", "backend", [
      "method",
      "path",
      "status",
    ]),
    metric("session.turn.duration", "Session turn latency", "ms", "duration", "p95", "session", "backend", ["status"]),
    metric("session.turn.active", "Active session turns", "count", "gauge", "latest", "session", "backend", [], {
      aliases: ["session.active_turns"],
    }),
    metric("session.turn.error", "Session turn errors", "count", "counter", "sum", "session", "backend", ["error"]),
    metric("session.turn.retry", "Session turn retries", "count", "counter", "sum", "session", "backend", ["reason"]),
    metric(
      "session.execution_phase.duration",
      "Session execution phase latency",
      "ms",
      "duration",
      "p95",
      "session",
      "backend",
      ["phase"],
    ),
    metric("agent.queue.depth", "Agent queue depth", "count", "gauge", "latest", "session", "backend", []),
    metric("agent.queue.wait", "Agent queue wait", "ms", "duration", "p95", "session", "backend", []),
    metric("agent.turn.duration", "Agent turn latency", "ms", "duration", "p95", "session", "backend", ["reason"]),
    metric("agent.ipc.request_bytes", "Agent IPC request bytes", "bytes", "size", "avg", "session", "backend", []),
    metric("agent.ipc.event_bytes", "Agent IPC event bytes", "bytes", "size", "avg", "session", "backend", []),
    metric("agent.worker.rss", "Agent worker RSS", "bytes", "gauge", "latest", "session", "process", [
      "phase",
      "turns",
    ]),
    metric("agent.worker.heap_used", "Agent worker heap used", "bytes", "gauge", "latest", "session", "process", [
      "phase",
      "turns",
    ]),
    metric("agent.worker.heap_total", "Agent worker heap total", "bytes", "gauge", "latest", "session", "process", [
      "phase",
      "turns",
    ]),
    metric("agent.worker.external", "Agent worker external memory", "bytes", "gauge", "latest", "session", "process", [
      "phase",
      "turns",
    ]),
    metric(
      "agent.worker.array_buffers",
      "Agent worker ArrayBuffer memory",
      "bytes",
      "gauge",
      "latest",
      "session",
      "process",
      ["phase", "turns"],
    ),
    metric("agent.worker.crash", "Agent worker crashes", "count", "counter", "sum", "session", "process", [
      "exitCode",
      "signal",
    ]),
    metric("agent.worker.recycle", "Agent worker recycles", "count", "counter", "sum", "session", "process", [
      "reason",
    ]),
    metric(
      "agent.worker.heartbeat_timeout",
      "Agent worker heartbeat timeouts",
      "count",
      "counter",
      "sum",
      "session",
      "process",
      [],
    ),
    metric("session.tool.count", "Session tool calls", "count", "counter", "sum", "session", "backend", ["tool"]),
    metric("session.llm.count", "Session LLM calls", "count", "counter", "sum", "session", "backend", [
      "providerID",
      "modelID",
    ]),
    metric(
      "llm.request.duration",
      "LLM request latency",
      "ms",
      "duration",
      "p95",
      "llm",
      "backend",
      ["providerID", "modelID", "status"],
      { aliases: ["llm.call.duration"] },
    ),
    metric(
      "llm.stream.start",
      "LLM stream start latency",
      "ms",
      "duration",
      "p95",
      "llm",
      "backend",
      ["providerID", "modelID"],
      { aliases: ["llm.stream.start_ms"] },
    ),
    metric(
      "llm.stream.first_token",
      "LLM first token latency",
      "ms",
      "duration",
      "p95",
      "llm",
      "backend",
      ["providerID", "modelID"],
      { aliases: ["llm.first_token.ms"] },
    ),
    metric(
      "llm.stream.output_chars",
      "LLM output characters",
      "count",
      "counter",
      "sum",
      "llm",
      "backend",
      ["providerID", "modelID"],
      { aliases: ["llm.output.chars"] },
    ),
    metric("llm.stream.chunk_gap", "Average LLM stream chunk gap", "ms", "duration", "p95", "llm", "backend", [
      "provider",
      "model",
      "kind",
    ]),
    metric(
      "llm.stream.output_chars_per_second",
      "LLM stream character throughput",
      "count",
      "rate",
      "avg",
      "llm",
      "backend",
      ["provider", "model", "kind"],
    ),
    metric("llm.tokens.input", "LLM input tokens", "tokens", "counter", "sum", "llm", "backend", [
      "providerID",
      "modelID",
    ]),
    metric("llm.tokens.output", "LLM output tokens", "tokens", "counter", "sum", "llm", "backend", [
      "providerID",
      "modelID",
    ]),
    metric("llm.request.count", "LLM request count", "count", "counter", "sum", "llm", "backend", [
      "providerID",
      "modelID",
    ]),
    metric("tool.execution.duration", "Tool execution latency", "ms", "duration", "p95", "tool", "backend", [
      "tool",
      "status",
    ]),
    metric("tool.execution.count", "Tool execution count", "count", "counter", "sum", "tool", "backend", ["tool"], {
      aliases: ["tool.call.count"],
    }),
    metric("tool.execution.error", "Tool execution errors", "count", "counter", "sum", "tool", "backend", ["tool"]),
    metric("tool.execution.stalled", "Tool stalled events", "count", "counter", "sum", "tool", "backend", ["tool"]),
    metric("tool.phase.duration", "Tool phase latency", "ms", "duration", "p95", "tool", "backend", ["tool", "phase"]),
    metric("tool.queue.depth", "Tool queue depth", "count", "gauge", "latest", "tool", "backend", ["tool"]),
    metric("tool.queue.wait", "Tool queue wait", "ms", "duration", "p95", "tool", "backend", ["tool", "executor"]),
    metric("tool.scheduler.duration", "Scheduled tool latency", "ms", "duration", "p95", "tool", "backend", [
      "tool",
      "executor",
    ]),
    metric("storage.operation.duration", "Storage operation latency", "ms", "duration", "p95", "storage", "backend", [
      "operation",
      "status",
    ]),
    metric("storage.operation.count", "Storage operations", "count", "counter", "sum", "storage", "backend", [
      "operation",
    ]),
    metric("storage.operation.error", "Storage operation errors", "count", "counter", "sum", "storage", "backend", [
      "operation",
    ]),
    metric("storage.read.bytes", "Storage read bytes", "bytes", "counter", "sum", "storage", "backend", ["operation"]),
    metric("storage.write.bytes", "Storage written bytes", "bytes", "counter", "sum", "storage", "backend", [
      "operation",
    ]),
    metric(
      "library.operation.duration",
      "Library operation latency",
      "ms",
      "duration",
      "p95",
      "library",
      "backend",
      ["operation"],
      { aliases: ["library.query.duration"] },
    ),
    metric("library.operation.error", "Library operation errors", "count", "counter", "sum", "library", "backend", [
      "operation",
    ]),
    metric("frontend.web_vital", "Frontend web vital", "ms", "duration", "p95", "frontend", "browser", [
      "name",
      "routeName",
      "pathTemplate",
    ]),
    metric("frontend.resource.duration", "Frontend resource latency", "ms", "duration", "p95", "frontend", "browser", [
      "name",
      "initiatorType",
      "routeName",
      "pathTemplate",
    ]),
    metric(
      "frontend.long_task.duration",
      "Frontend long task latency",
      "ms",
      "duration",
      "p95",
      "frontend",
      "browser",
      ["attribution", "routeName", "pathTemplate"],
    ),
    metric(
      "frontend.collector.rejected",
      "Frontend rejected samples",
      "count",
      "counter",
      "sum",
      "frontend",
      "browser",
      [],
    ),
    metric("process.memory.rss", "RSS memory", "bytes", "gauge", "latest", "process", "process", []),
    metric("process.child.memory.rss", "Child process RSS memory", "bytes", "gauge", "latest", "process", "process", [
      "command",
      "backgrounded",
    ]),
    metric("process.memory.heap_used", "Heap used", "bytes", "gauge", "latest", "process", "process", []),
    metric("process.memory.heap_total", "Heap total", "bytes", "gauge", "latest", "process", "process", [], {
      status: "derived",
    }),
    metric("process.memory.external", "External memory", "bytes", "gauge", "latest", "process", "process", []),
    metric("process.memory.array_buffers", "ArrayBuffer memory", "bytes", "gauge", "latest", "process", "process", []),
    metric("process.cpu.utilization", "CPU utilization", "ratio", "ratio", "avg", "process", "process", []),
    metric("process.event_loop.lag", "Event-loop lag", "ms", "duration", "p95", "process", "process", []),
    metric("process.active.count", "Active processes", "count", "gauge", "latest", "process", "process", [], {
      aliases: ["process.active"],
    }),
    metric("pty.session.duration", "PTY session duration", "ms", "duration", "p95", "pty", "backend", []),
    metric("pty.connection.open", "PTY open connections", "count", "gauge", "latest", "pty", "backend", []),
    metric("pty.connection.duration", "PTY connection duration", "ms", "duration", "p95", "pty", "backend", []),
    metric("pty.write.failure", "PTY write failures", "count", "counter", "sum", "pty", "backend", []),
    metric("server.sse.connection.open", "SSE open connections", "count", "gauge", "latest", "server", "backend", []),
    metric(
      "server.sse.connection.duration",
      "SSE connection duration",
      "ms",
      "duration",
      "p95",
      "server",
      "backend",
      [],
    ),
    metric("server.sse.heartbeat", "SSE heartbeats", "count", "counter", "sum", "server", "backend", []),
    metric("server.sse.write_dropped", "SSE dropped writes", "count", "counter", "sum", "server", "backend", []),
    metric("server.sse.write_failure", "SSE write failures", "count", "counter", "sum", "server", "backend", []),
    metric(
      "observability.writer.dropped",
      "Dropped observability writes",
      "count",
      "counter",
      "sum",
      "observability",
      "backend",
      [],
    ),
    metric(
      "observability.writer.queue_depth",
      "Observability queue depth",
      "count",
      "gauge",
      "latest",
      "observability",
      "backend",
      [],
    ),
    metric(
      "observability.writer.flush.duration",
      "Observability flush latency",
      "ms",
      "duration",
      "p95",
      "observability",
      "backend",
      [],
    ),
    metric(
      "observability.writer.append_failure",
      "Observability append failures",
      "count",
      "counter",
      "sum",
      "observability",
      "backend",
      [],
    ),
    metric(
      "llm.turn.history.before_bytes",
      "LLM history before projection",
      "bytes",
      "size",
      "latest",
      "llm",
      "backend",
      ["phase", "providerID", "modelID"],
    ),
    metric(
      "llm.turn.history.after_bytes",
      "LLM history after projection",
      "bytes",
      "size",
      "latest",
      "llm",
      "backend",
      ["phase", "providerID", "modelID"],
    ),
    metric("llm.turn.request.bytes", "LLM request size", "bytes", "size", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.tool_schema.bytes", "LLM tool schema size", "bytes", "size", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.output_chars", "LLM turn output characters", "count", "gauge", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.tool_raw_chars", "LLM tool input characters", "count", "gauge", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.active_streams", "Active LLM streams", "count", "gauge", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.memory.heap_used_delta", "LLM turn heap delta", "bytes", "gauge", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric("llm.turn.memory.external_delta", "LLM turn external delta", "bytes", "gauge", "latest", "llm", "backend", [
      "phase",
      "providerID",
      "modelID",
    ]),
    metric(
      "llm.turn.memory.array_buffers_delta",
      "LLM turn ArrayBuffer delta",
      "bytes",
      "gauge",
      "latest",
      "llm",
      "backend",
      ["phase", "providerID", "modelID"],
    ),
  ] satisfies MetricInfo[]

  export const metrics = metricList
  export const chartMetricNames = [
    "process.cpu.utilization",
    "process.event_loop.lag",
    "process.memory.rss",
    "process.memory.heap_used",
    "process.memory.heap_total",
    "process.memory.external",
    "process.memory.array_buffers",
    "http.request.duration",
    "session.turn.duration",
    "session.turn.active",
    "storage.operation.count",
    "storage.operation.duration",
    "storage.read.bytes",
    "storage.write.bytes",
  ]
  export const defaultMetricNames = [
    "http.request.duration",
    "process.memory.rss",
    "process.memory.heap_used",
    "process.cpu.utilization",
    "process.event_loop.lag",
  ]

  const byName = new Map(metricList.map((entry) => [entry.name, entry]))
  const aliasToName = new Map(
    metricList.flatMap((entry) => (entry.aliases ?? []).map((alias) => [alias, entry.name] as const)),
  )
  const queryable = new Set(metricList.filter((entry) => entry.status !== "internal").map((entry) => entry.name))
  for (const alias of aliasToName.keys()) queryable.add(alias)

  export function allMetricNames() {
    return [...queryable]
  }

  export function get(name: string) {
    return byName.get(resolveName(name))
  }

  export function resolveName(name: string) {
    return aliasToName.get(name) ?? name
  }

  function metric(
    name: string,
    label: string,
    unit: PerformanceSchema.Unit,
    kind: Kind,
    defaultStat: Stat,
    module: PerformanceSchema.Module,
    source: PerformanceSchema.Source,
    labels: string[],
    opts: Partial<Pick<MetricInfo, "aliases" | "status">> = {},
  ): MetricInfo {
    return {
      name,
      label,
      unit,
      kind,
      defaultStat,
      module,
      source,
      labels,
      status: opts.status ?? "emitted",
      aliases: opts.aliases,
    }
  }
}
