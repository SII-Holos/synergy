export class PerformanceError extends Error {
  constructor(
    readonly code: PerformanceError.Code,
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "PerformanceError"
  }

  toResponse() {
    return { code: this.code, message: this.message, ...this.data }
  }
}

export namespace PerformanceError {
  export type Code =
    | "PERF_INVALID_QUERY"
    | "PERF_TOO_MANY_BUCKETS"
    | "PERF_FORBIDDEN"
    | "PERF_RATE_LIMITED"
    | "PERF_OBSERVABILITY_UNAVAILABLE"
    | "PERF_TRACE_NOT_FOUND"
    | "PERF_INVALID_METRIC_BATCH"
    | "PERF_CONFIG_RESTART_REQUIRED"
    | "PERF_CONFIG_CONFLICT"
    | "PERF_STORAGE_UNAVAILABLE"
    | "PERF_SPAN_CONFLICT"
    | "PERF_ANALYSIS_NOT_FOUND"
    | "PERF_ANALYSIS_UNAVAILABLE"
}
