import { expect, mock, test } from "bun:test"
import { AgentTurn } from "../../src/session/agent-turn"
import { AgentWorkerPool } from "../../src/session/agent-turn/worker-pool"
import { ContextUsage } from "../../src/session/context-usage"
import { LLM } from "../../src/session/llm"

test("starts Context Usage estimation only after the Agent worker starts", async () => {
  const originalTestHome = process.env.SYNERGY_TEST_HOME
  const originalPrepare = LLM.prepare
  const originalRun = AgentWorkerPool.prototype.run
  const originalMeasureDraft = ContextUsage.measureDraft
  const started = Promise.withResolvers<AgentTurn.Stream>()
  let estimationStarts = 0

  try {
    await AgentTurn.stop()
    AgentTurn.configure({ minIdle: 0 })
    delete process.env.SYNERGY_TEST_HOME
    ;(LLM.prepare as any) = mock(async () => ({
      system: ["prepared system"],
      baseSystemLength: 1,
      provider: {
        options: {},
        timeouts: { ttfbMs: 1_000, idleMs: false, wallMs: false },
      },
      params: { options: {} },
    }))
    ;(AgentWorkerPool.prototype.run as any) = mock(() => started.promise)
    ;(ContextUsage.measureDraft as any) = mock(async () => {
      estimationStarts++
      return undefined
    })

    const pending = AgentTurn.stream({
      user: { id: "msg_user" },
      sessionID: "ses_test",
      model: { id: "test-model", providerID: "test-provider", limit: {} },
      agent: { name: "synergy" },
      system: [],
      messages: [],
      abort: new AbortController().signal,
      toolDefinitions: [],
      contextUsageProvenance: {
        categories: {
          conversation: [{ text: "queued prompt" }],
          toolActivity: [],
          filesReferences: [],
          instructions: [],
        },
        items: { conversation: 1, toolActivity: 0, filesReferences: 0, instructions: 0 },
      },
    } as any)

    await Bun.sleep(0)
    expect(estimationStarts).toBe(0)

    started.resolve({
      fullStream: (async function* () {})(),
      usage: Promise.resolve(undefined),
      async dispose() {},
    })
    const stream = await pending

    expect(estimationStarts).toBe(1)
    expect(stream.contextUsageDraft).toBeDefined()
    await stream.contextUsageDraft
  } finally {
    ;(LLM.prepare as any) = originalPrepare
    ;(AgentWorkerPool.prototype.run as any) = originalRun
    ;(ContextUsage.measureDraft as any) = originalMeasureDraft
    if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalTestHome
    await AgentTurn.stop()
    AgentTurn.configure()
  }
})
