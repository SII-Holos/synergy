import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import type { MessageV2 } from "../../src/session/message-v2"

const originalAgentGet = Agent.get
const originalAgentModel = Agent.getAvailableModel
const originalProviderGetModel = Provider.getModel
const originalStream = LLM.stream

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.getAvailableModel as any) = originalAgentModel
  ;(Provider.getModel as any) = originalProviderGetModel
  ;(LLM.stream as any) = originalStream
})

function installAgentMocks() {
  ;(Agent.get as any) = mock(async () => ({ name: "script", prompt: "script" }))
  ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test", modelID: "test-model" }))
  ;(Provider.getModel as any) = mock(async () => ({
    id: "test-model",
    providerID: "test",
    modelID: "test-model",
  }))
}

function agentContext(overrides: Partial<Config.Learning> = {}) {
  return {
    sessionID: "ses_test",
    userMsg: {
      id: "msg_user",
      sessionID: "ses_test",
      role: "user",
      time: { created: Date.now() },
      model: { providerID: "test", modelID: "test-model" },
    } as MessageV2.User,
    model: {
      id: "test-model",
      providerID: "test",
      modelID: "test-model",
    } as unknown as Provider.Model,
    learning: {
      ...Config.LEARNING_DEFAULTS,
      rewardWeights: { ...Config.REWARD_WEIGHT_DEFAULTS },
      ...overrides,
    } as Required<Config.Learning>,
  }
}

describe("ExperienceEncoder stream bounds", () => {
  test("collectBoundedText aborts oversized streams", async () => {
    const abort = new AbortController()
    const stream = (async function* () {
      yield "1. step one\n"
      yield "x".repeat(100)
      yield "still more"
    })()

    await expect(
      ExperienceEncoder.collectBoundedText({
        textStream: stream,
        maxChars: 50,
        abort,
      }),
    ).rejects.toMatchObject({
      name: "EncoderStreamError",
      code: "oversized",
    })
    expect(abort.signal.aborted).toBe(true)
  })

  test("collectBoundedText returns complete bounded text", async () => {
    const stream = (async function* () {
      yield "1. Inspect the failing path\n"
      yield "2. Bound the encoder stream\n"
      yield "3. Record encoding_failed on timeout\n"
    })()

    await expect(
      ExperienceEncoder.collectBoundedText({
        textStream: stream,
        maxChars: 1_000,
      }),
    ).resolves.toBe("1. Inspect the failing path\n2. Bound the encoder stream\n3. Record encoding_failed on timeout\n")
  })

  test("callAgent fails closed on oversized script streams", async () => {
    installAgentMocks()
    let aborted = false
    ;(LLM.stream as any) = mock(async (input: { abort: AbortSignal }) => {
      input.abort.addEventListener("abort", () => {
        aborted = true
      })
      return {
        textStream: (async function* () {
          yield "1. start\n"
          yield "x".repeat(200)
          if (input.abort.aborted) return
          yield "should not be collected"
        })(),
        text: Promise.resolve("unused"),
      }
    })

    await expect(
      ExperienceEncoder.callAgentForTest("script", agentContext({ encoderMaxOutputChars: 50 }), "raw conversation"),
    ).rejects.toMatchObject({
      name: "EncoderStreamError",
      code: "oversized",
    })
    expect(aborted).toBe(true)
  })

  test("callAgent fails closed when the stream never finishes", async () => {
    installAgentMocks()
    ;(LLM.stream as any) = mock(async () => {
      return {
        textStream: (async function* () {
          yield "1. partial\n"
          await new Promise(() => {})
        })(),
        text: new Promise<string>(() => {}),
      }
    })

    await expect(
      ExperienceEncoder.callAgentForTest("script", agentContext({ encoderTimeoutMs: 40 }), "raw conversation"),
    ).rejects.toMatchObject({
      name: "EncoderStreamError",
      code: "timeout",
    })
  })

  test("learning defaults expose encoder timeout and output bounds", () => {
    expect(Config.LEARNING_DEFAULTS.encoderTimeoutMs).toBe(60_000)
    expect(Config.LEARNING_DEFAULTS.encoderMaxOutputChars).toBe(16_000)
  })
})
