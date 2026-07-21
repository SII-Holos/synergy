import { ObservabilityMetrics } from "@/observability/metrics"

export namespace ServerSseMetrics {
  export function open(stream: string) {
    record("server.sse.connection.open", 1, { stream })
  }

  export function heartbeat(stream: string) {
    record("server.sse.heartbeat", 1, { stream })
  }

  export function writeDropped(stream: string, event: string) {
    record("server.sse.write_dropped", 1, { stream, event })
  }

  export function writeFailure(stream: string, event?: string) {
    record("server.sse.write_failure", 1, event ? { stream, event } : { stream })
  }

  export function duration(stream: string, connectedAt: number) {
    record("server.sse.connection.duration", Date.now() - connectedAt, { stream }, "ms")
  }

  function record(name: string, value: number, labels: Record<string, string>, unit: "count" | "ms" = "count") {
    ObservabilityMetrics.record({
      name,
      value,
      unit,
      module: "server",
      labels,
    })
  }
}
