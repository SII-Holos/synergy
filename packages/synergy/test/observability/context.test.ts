import { describe, expect, test } from "bun:test"
import { ObservabilityContext } from "../../src/observability/context"

describe("ObservabilityContext", () => {
  test("inherits context across nested async calls", async () => {
    await ObservabilityContext.withContextAsync(
      { correlationId: "corr_parent", traceId: "trace_parent", spanId: "span_parent", module: "session" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(ObservabilityContext.current()).toMatchObject({
          correlationId: "corr_parent",
          traceId: "trace_parent",
          spanId: "span_parent",
          module: "session",
        })

        const child = ObservabilityContext.child({ spanId: "span_child", module: "tool" })
        expect(child).toMatchObject({
          correlationId: "corr_parent",
          traceId: "trace_parent",
          parentSpanId: "span_parent",
          spanId: "span_child",
          module: "tool",
        })
      },
    )
  })

  test("keeps parallel correlations isolated", async () => {
    const [first, second] = await Promise.all([
      ObservabilityContext.withContextAsync({ correlationId: "corr_a", traceId: "trace_a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return ObservabilityContext.current()
      }),
      ObservabilityContext.withContextAsync({ correlationId: "corr_b", traceId: "trace_b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return ObservabilityContext.current()
      }),
    ])

    expect(first.correlationId).toBe("corr_a")
    expect(second.correlationId).toBe("corr_b")
  })
})
