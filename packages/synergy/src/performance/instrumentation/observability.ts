export namespace PerformanceObservabilityInstrumentation {
  export const module = "observability" as const
  export const metric = {
    dropped: "observability.writer.dropped",
    queueDepth: "observability.writer.queue_depth",
    flushDuration: "observability.writer.flush.duration",
  } as const
}
