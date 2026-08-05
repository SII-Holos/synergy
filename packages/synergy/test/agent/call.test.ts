import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentCall } from "../../src/agent/call"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"

const originalAgentGet = Agent.get
const originalAgentModel = Agent.getAvailableModel
const originalProviderGetModel = Provider.getModel
const originalResolveRoleModel = Provider.resolveRoleModel
const originalStream = LLM.stream
const originalTakeTextStream = LLM.takeTextStream
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.getAvailableModel as any) = originalAgentModel
  ;(Provider.getModel as any) = originalProviderGetModel
  ;(Provider.resolveRoleModel as any) = originalResolveRoleModel
  ;(LLM.stream as any) = originalStream
  ;(LLM.takeTextStream as any) = originalTakeTextStream
  globalThis.setTimeout = originalSetTimeout
})

function installAgent() {
  ;(Agent.get as any) = mock(async () => ({ name: "internal", prompt: "prompt" }))
  ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test", modelID: "model" }))
  ;(Provider.getModel as any) = mock(async () => ({ providerID: "test", id: "model" }))
}

function call(overrides: Partial<AgentCall.TextInput> = {}) {
  return AgentCall.text({
    agent: "internal",
    messages: [{ role: "user", content: "input" }],
    timeoutMs: 1_000,
    retries: 1,
    maxOutputChars: 100,
    ...overrides,
  })
}

describe("AgentCall", () => {
  test("resolves an Agent model and collects bounded text without creating a Session", async () => {
    installAgent()
    let streamInput: Record<string, unknown> | undefined
    ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
      streamInput = input
      return {
        textStream: (async function* () {
          yield "answer"
        })(),
      }
    })

    await expect(call()).resolves.toMatchObject({ text: "answer" })
    expect(streamInput?.tools).toEqual({})
    expect(streamInput?.sessionID).toBeString()
  })

  test("uses an explicit fallback when the Agent model is unavailable", async () => {
    installAgent()
    ;(Agent.getAvailableModel as any) = mock(async () => undefined)
    const fallback = { providerID: "fallback", id: "fallback-model" } as Provider.Model
    ;(LLM.stream as any) = mock(async (input: { model: Provider.Model }) => {
      expect(input.model).toBe(fallback)
      return { textStream: (async function* () {})() }
    })
    await expect(call({ fallbackModel: fallback })).resolves.toMatchObject({ text: "" })

    installAgent()
    ;(Provider.getModel as any) = mock(async () => {
      throw new Error("configured model unavailable")
    })
    ;(LLM.stream as any) = mock(async (input: { model: Provider.Model }) => {
      expect(input.model).toBe(fallback)
      return { textStream: (async function* () {})() }
    })
    await expect(call({ fallbackModel: fallback })).resolves.toMatchObject({ text: "" })
  })

  test("uses a requested model role instead of the Agent default", async () => {
    installAgent()
    ;(Provider.resolveRoleModel as any) = mock(async (role: string) => {
      expect(role).toBe("thinking")
      return { providerID: "role-provider", modelID: "role-model" }
    })
    ;(Provider.getModel as any) = mock(async (providerID: string, modelID: string) => {
      expect({ providerID, modelID }).toEqual({
        providerID: "role-provider",
        modelID: "role-model",
      })
      return { providerID, id: modelID }
    })
    ;(LLM.stream as any) = mock(async () => ({
      textStream: (async function* () {
        yield "role answer"
      })(),
    }))

    await expect(call({ modelRole: "thinking" })).resolves.toMatchObject({ text: "role answer" })
  })

  test("rejects missing agents and models with stable codes", async () => {
    ;(Agent.get as any) = mock(async () => undefined)
    await expect(call()).rejects.toMatchObject({ name: "AgentCallError", code: "agent_not_found" })

    installAgent()
    ;(Agent.getAvailableModel as any) = mock(async () => undefined)
    await expect(call()).rejects.toMatchObject({ name: "AgentCallError", code: "model_unavailable" })
  })

  test("bounds input and output", async () => {
    installAgent()
    await expect(call({ maxInputChars: 2 })).rejects.toMatchObject({ code: "input_too_large" })
    let aborted = false
    ;(LLM.stream as any) = mock(async (input: { abort: AbortSignal }) => {
      input.abort.addEventListener("abort", () => {
        aborted = true
      })
      return {
        textStream: (async function* () {
          yield "12345"
          yield "67890"
        })(),
      }
    })
    await expect(call({ maxOutputChars: 6 })).rejects.toMatchObject({ code: "output_too_large" })
    expect(aborted).toBe(true)
  })

  test("settles timeout and caller cancellation even when a stream stalls", async () => {
    installAgent()
    ;(LLM.stream as any) = mock(async () => ({
      textStream: (async function* () {
        yield "partial"
        await new Promise(() => {})
      })(),
    }))
    await expect(call({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" })

    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    await Bun.sleep(0)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })

  test("does not keep the process alive while a call timeout is pending", async () => {
    installAgent()
    let callTimer: { hasRef?: () => boolean } | undefined
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(handler, timeout, ...args)
      if (timeout === 1_000) callTimer = timer as unknown as { hasRef?: () => boolean }
      return timer
    }) as typeof setTimeout
    const streamStarted = Promise.withResolvers<void>()
    ;(LLM.stream as any) = mock(async () => {
      streamStarted.resolve()
      return {
        textStream: (async function* () {
          if (false) yield ""
          await new Promise(() => {})
        })(),
      }
    })
    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    await streamStarted.promise
    expect(callTimer?.hasRef?.()).toBe(false)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })

  test("disposes its owned text stream after success and failure", async () => {
    installAgent()
    ;(LLM.stream as any) = mock(async () => ({}))
    let disposed = 0
    ;(LLM.takeTextStream as any) = mock(() => ({
      stream: (async function* () {
        yield "answer"
      })(),
      dispose: async () => void disposed++,
    }))
    await call()
    expect(disposed).toBe(1)
    ;(LLM.takeTextStream as any) = mock(() => ({
      stream: (async function* () {
        yield* [] as string[]
        throw new Error("stream failed")
      })(),
      dispose: async () => void disposed++,
    }))
    await expect(call()).rejects.toThrow("stream failed")
    expect(disposed).toBe(2)
  })

  test("prefers an explicit model override over agent and role resolution", async () => {
    installAgent()
    let resolveCalls = 0
    ;(Provider.resolveRoleModel as any) = mock(async () => {
      resolveCalls++
      return { providerID: "role-provider", modelID: "role-model" }
    })
    const explicit = { providerID: "explicit", id: "explicit-model" } as Provider.Model
    let streamModel: Provider.Model | undefined
    ;(LLM.stream as any) = mock(async (input: { model: Provider.Model }) => {
      streamModel = input.model
      return {
        textStream: (async function* () {
          yield "override"
        })(),
      }
    })
    await expect(call({ model: explicit, modelRole: "thinking" })).resolves.toMatchObject({ text: "override" })
    expect(streamModel).toBe(explicit)
    expect(resolveCalls).toBe(0)
  })

  test("forwards maxOutputTokens to the stream", async () => {
    installAgent()
    let streamInput: Record<string, unknown> | undefined
    ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
      streamInput = input
      return { textStream: (async function* () {})() }
    })
    await call({ maxOutputTokens: 123 })
    expect(streamInput?.maxOutputTokens).toBe(123)
  })

  test("defaults to small options and forwards an explicit override", async () => {
    installAgent()
    let smallDefault: unknown
    ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
      smallDefault = input.small
      return { textStream: (async function* () {})() }
    })
    await call()
    expect(smallDefault).toBe(true)

    let smallOverride: unknown
    ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
      smallOverride = input.small
      return { textStream: (async function* () {})() }
    })
    await call({ small: false })
    expect(smallOverride).toBe(false)
  })

  test("forwards sessionId and userMetadata to the synthesized user", async () => {
    installAgent()
    let streamInput: Record<string, unknown> | undefined
    ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
      streamInput = input
      return { textStream: (async function* () {})() }
    })
    await call({ sessionId: "ses_test", userMetadata: { source: "integration:github" } })
    expect(streamInput?.sessionID).toBe("ses_test")
    expect((streamInput?.user as { metadata?: unknown } | undefined)?.metadata).toEqual({
      source: "integration:github",
    })
  })

  test("returns usage and the resolved model", async () => {
    installAgent()
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    ;(LLM.stream as any) = mock(async () => ({
      textStream: (async function* () {
        yield "answer"
      })(),
      usage: Promise.resolve(usage),
    }))
    const result = await call()
    expect(result.text).toBe("answer")
    expect(result.model).toMatchObject({ providerID: "test", id: "model" })
    expect(result.usage).toEqual(usage)
  })
})
