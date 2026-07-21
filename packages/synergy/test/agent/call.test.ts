import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentCall } from "../../src/agent/call"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"

const originalAgentGet = Agent.get
const originalAgentModel = Agent.getAvailableModel
const originalProviderGetModel = Provider.getModel
const originalStream = LLM.stream
const originalTakeTextStream = LLM.takeTextStream

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.getAvailableModel as any) = originalAgentModel
  ;(Provider.getModel as any) = originalProviderGetModel
  ;(LLM.stream as any) = originalStream
  ;(LLM.takeTextStream as any) = originalTakeTextStream
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

    await expect(call()).resolves.toEqual({ text: "answer" })
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
    await expect(call({ fallbackModel: fallback })).resolves.toEqual({ text: "" })

    installAgent()
    ;(Provider.getModel as any) = mock(async () => {
      throw new Error("configured model unavailable")
    })
    ;(LLM.stream as any) = mock(async (input: { model: Provider.Model }) => {
      expect(input.model).toBe(fallback)
      return { textStream: (async function* () {})() }
    })
    await expect(call({ fallbackModel: fallback })).resolves.toEqual({ text: "" })
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
})
