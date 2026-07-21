import { beforeEach, describe, expect, test } from "bun:test"
import { LLMTurnMemory } from "../../src/session/llm-memory"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"

describe("LLMTurnMemory", () => {
  beforeEach(() => {
    LLMTurnMemory.resetForTest()
    SessionMemoryPressure.resetForTest()
  })

  test("tracks bounded turn sizes, active streams, and memory deltas", () => {
    let heapUsedBytes = 100
    LLMTurnMemory.setSnapshotForTest(() => ({
      rssBytes: 200,
      heapUsedBytes,
      heapTotalBytes: 150,
      externalBytes: 40,
      arrayBuffersBytes: 20,
    }))

    const turn = LLMTurnMemory.begin({
      sessionID: "ses_memory",
      messageID: "msg_memory",
      providerID: "provider",
      modelID: "model",
      historyBeforeBytes: 1_000,
    })
    heapUsedBytes = 180
    turn.projected({ historyAfterBytes: 700 })
    turn.prepared({ requestBytes: 1_500, toolSchemaBytes: 300 })
    turn.streamStarted()
    turn.addOutputChars(25)
    turn.observeToolRawChars("call_1", 80)
    turn.observeToolRawChars("call_2", 20)

    expect(LLMTurnMemory.stats()).toMatchObject({ activeTurnCount: 1, activeStreamCount: 1 })
    expect(LLMTurnMemory.activeSnapshot()[0]).toMatchObject({
      historyBeforeBytes: 1_000,
      historyAfterBytes: 700,
      requestBytes: 1_500,
      toolSchemaBytes: 300,
      outputChars: 25,
      toolRawChars: 100,
      activeStreamCount: 1,
      memoryDelta: { heapUsedBytes: 80 },
    })

    turn.release()
    expect(LLMTurnMemory.stats()).toEqual({ activeTurnCount: 0, activeStreamCount: 0 })
    expect(LLMTurnMemory.incidentSnapshot()[0]).toMatchObject({
      sessionID: "ses_memory",
      requestBytes: 1_500,
      outputChars: 25,
    })
  })

  test("estimates serialized UTF-8 size without constructing a JSON payload", () => {
    expect(LLMTurnMemory.estimateBytes({ text: "科学", values: [1, true, null] })).toBeGreaterThan(20)
    expect(LLMTurnMemory.estimateBytes("科学")).toBe(8)
    expect(LLMTurnMemory.estimateChars("科学")).toBe(4)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(LLMTurnMemory.estimateBytes(cyclic)).toBeGreaterThan(0)
  })

  test("stabilizes soft pressure with GC before history projection", async () => {
    const original = {
      soft: process.env.SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES,
      heapCritical: process.env.SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES,
      rssCritical: process.env.SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES,
      externalCritical: process.env.SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES,
      arraysCritical: process.env.SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES,
    }
    process.env.SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES = "1"
    process.env.SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER)
    process.env.SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER)
    process.env.SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER)
    process.env.SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER)
    const phases: string[] = []

    try {
      const turn = LLMTurnMemory.begin({
        sessionID: "ses_soft",
        messageID: "msg_soft",
        providerID: "provider",
        modelID: "model",
        historyBeforeBytes: 10,
        baseline: {
          rssBytes: 10,
          heapUsedBytes: 10,
          heapTotalBytes: 20,
          externalBytes: 1,
          arrayBuffersBytes: 1,
        },
      })
      await SessionMemoryPressure.maybeCollect({
        phase: "llm.turn.history.before_projection",
        snapshot: () => ({
          rssBytes: 10,
          heapUsedBytes: 10,
          heapTotalBytes: 20,
          externalBytes: 1,
          arrayBuffersBytes: 1,
        }),
        collect: () => {
          phases.push("llm.turn.history.before_projection")
        },
        env: process.env,
      })
      await turn.stabilizeBeforeProjection()
      turn.release()
      expect(phases).toEqual(["llm.turn.history.before_projection"])
    } finally {
      restoreEnv("SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES", original.soft)
      restoreEnv("SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES", original.heapCritical)
      restoreEnv("SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES", original.rssCritical)
      restoreEnv("SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES", original.externalCritical)
      restoreEnv("SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES", original.arraysCritical)
    }
  })
})

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
