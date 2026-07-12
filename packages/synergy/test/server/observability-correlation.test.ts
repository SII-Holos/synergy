import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityStore } from "../../src/observability/store"
import { Server } from "../../src/server/server"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

describe("server observability correlation", () => {
  beforeEach(() => resetObservabilityHome("synergy-observability-correlation-"))
  afterEach(() => cleanupObservabilityHomes())

  test("propagates incoming correlation headers but keeps server-owned root trace IDs", async () => {
    const response = await Server.App().request("/agent", {
      headers: {
        "x-synergy-correlation-id": "corr_http_test",
        "x-synergy-trace-id": "trace_http_test",
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("x-synergy-correlation-id")).toBe("corr_http_test")
    const traceId = response.headers.get("x-synergy-trace-id")
    expect(traceId).toStartWith("http_")
    expect(traceId).not.toBe("trace_http_test")

    await Promise.resolve()
    ObservabilityStore.flush()

    const spans = ObservabilityStore.querySpans({ traceId: traceId! })
    expect(spans.some((row) => row.name === "http.request" && row.correlation_id === "corr_http_test")).toBe(true)
    expect(JSON.stringify(spans.map((row) => JSON.parse(row.attributes_json)))).toContain("trace_http_test")
    expect(
      ObservabilityStore.queryMetrics({ since: 0, correlationId: "corr_http_test" }).some(
        (row) => row.name === "http.request.duration" && row.trace_id === traceId,
      ),
    ).toBe(true)
    expect(
      ObservabilityStore.queryEvents({ correlationId: "corr_http_test" }).some(
        (row) => row.type === "http.request" && row.trace_id === traceId,
      ),
    ).toBe(true)
  })

  test("generates correlation and trace headers when the client has none", async () => {
    const response = await Server.App().request("/agent")
    expect(response.status).toBe(200)
    const correlationId = response.headers.get("x-synergy-correlation-id")
    const traceId = response.headers.get("x-synergy-trace-id")
    expect(correlationId).toStartWith("corr_")
    expect(traceId).toStartWith("http_")

    ObservabilityStore.flush()
    expect(ObservabilityStore.querySpans({ traceId: traceId! })).toHaveLength(1)
    expect(ObservabilityStore.queryEvents({ correlationId: correlationId! }).length).toBeGreaterThanOrEqual(1)
  })
})
