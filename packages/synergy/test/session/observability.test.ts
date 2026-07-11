import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Config } from "../../src/config/config"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityContext } from "../../src/observability/context"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

describe("SessionProcessor observability", () => {
  beforeEach(() => resetObservabilityHome("synergy-session-observability-"))
  afterEach(() => cleanupObservabilityHomes())

  test("records LLM first token, chunk gap, and output throughput metrics", async () => {
    await runStreamScenario(async function* () {
      yield { type: "start" }
      yield { type: "text-start", id: "txt_1" }
      yield { type: "text-delta", id: "txt_1", text: "hello" }
      await new Promise((resolve) => setTimeout(resolve, 2))
      yield { type: "text-delta", id: "txt_1", text: " world" }
      yield { type: "text-end", id: "txt_1" }
      yield { type: "finish" }
    })
    ObservabilityStore.flush()

    const names = new Set(ObservabilityStore.queryMetrics({ since: 0, module: "llm" }).map((row) => row.name))
    expect(names).toContain("llm.stream.first_token")
    expect(names).toContain("llm.stream.output_chars")
    expect(names).toContain("llm.stream.chunk_gap")
    expect(names).toContain("llm.stream.output_chars_per_second")

    const gap = ObservabilityStore.queryMetrics({ since: 0, names: ["llm.stream.chunk_gap"] })[0]
    expect(gap.value).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(gap.labels_json).kind).toBe("text")
  })

  test("inherits the owning turn trace for LLM spans, events, and metrics", async () => {
    await runStreamScenario(
      async function* () {
        yield { type: "start" }
        yield { type: "text-start", id: "txt_trace" }
        yield { type: "text-delta", id: "txt_trace", text: "linked" }
        yield { type: "text-end", id: "txt_trace" }
        yield { type: "finish" }
      },
      { traceId: "trace_parent_turn", spanId: "span_parent_turn" },
    )
    ObservabilityStore.flush()

    const events = ObservabilityStore.queryEvents({ traceId: "trace_parent_turn", limit: 20 })
    expect(events.some((event) => event.type === "session.turn.start")).toBe(true)
    expect(events.some((event) => event.type === "session.turn.end")).toBe(true)
    const llmSpan = ObservabilityStore.querySpans({ traceId: "trace_parent_turn" }).find(
      (span) => span.name === "llm.request",
    )
    expect(llmSpan).toMatchObject({ parent_span_id: "span_parent_turn", status: "ok" })
    const metrics = ObservabilityStore.queryMetrics({ since: 0, traceId: "trace_parent_turn" })
    expect(metrics.some((metric) => metric.name === "llm.stream.output_chars")).toBe(true)
  })
})

async function runStreamScenario(
  stream: () => AsyncGenerator<Record<string, unknown>>,
  context?: { traceId: string; spanId: string },
) {
  const originalStream = LLM.stream
  const originalUpdatePart = Session.updatePart
  const originalUpdatePartDelta = Session.updatePartDelta
  const originalParts = MessageV2.parts
  const originalUpdateMessage = Session.updateMessage
  const originalUpdateLastExchange = Session.updateLastExchange
  const originalConfigCurrent = Config.current
  const originalPluginTrigger = Plugin.trigger
  const originalExperienceComplete = ExperienceEncoder.onComplete
  const parts = new Map<string, MessageV2.Part>()

  try {
    TimeoutConfig.invalidate()
    ;(Session.updatePart as any) = mock(async (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => {
      const part = "part" in input ? input.part : input
      parts.set(part.id, part)
      return part
    })
    ;(Session.updatePartDelta as any) = mock(async (part: MessageV2.TextPart | MessageV2.ReasoningPart) => {
      parts.set(part.id, part)
      return part
    })
    ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
    ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
    ;(Session.updateLastExchange as any) = mock(async () => {})
    ;(Config.current as any) = mock(async () => ({ experimental: {}, timeout: { tool: { default_sec: 60 } } }))
    ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
    ;(ExperienceEncoder.onComplete as any) = mock(() => {})
    ;(LLM.stream as any) = mock(async () => ({ fullStream: stream() }))

    const processor = SessionProcessor.create({
      assistantMessage: {
        id: "msg_assistant_obs",
        sessionID: "ses_obs",
        role: "assistant",
        parentID: "msg_user_obs",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        agent: "synergy",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0 },
      },
      sessionID: "ses_obs",
      model: { id: "test-model", modelID: "test-model", providerID: "test-provider" } as any,
      abort: new AbortController().signal,
    })
    const process = () => processor.process({} as any)
    if (context) await ObservabilityContext.withContextAsync(context, process)
    else await process()
  } finally {
    TimeoutConfig.invalidate()
    ;(LLM.stream as any) = originalStream
    ;(Session.updatePart as any) = originalUpdatePart
    ;(Session.updatePartDelta as any) = originalUpdatePartDelta
    ;(MessageV2.parts as any) = originalParts
    ;(Session.updateMessage as any) = originalUpdateMessage
    ;(Session.updateLastExchange as any) = originalUpdateLastExchange
    ;(Config.current as any) = originalConfigCurrent
    ;(Plugin.trigger as any) = originalPluginTrigger
    ;(ExperienceEncoder.onComplete as any) = originalExperienceComplete
  }
}
