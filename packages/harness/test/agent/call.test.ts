import { afterEach, describe, expect, mock, test, spyOn } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentTurn } from "../../src/session/agent-turn"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { SessionRetry } from "../../src/session/retry"
import { AgentCall } from "../../src/agent/call"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const originalAgentGet = Agent.get
const originalAgentModel = Agent.getAvailableModel
const originalProviderGetModel = Provider.getModel
const originalResolveRoleModel = Provider.resolveRoleModel
const originalStream = LLM.stream
const originalTakeTextStream = LLM.takeTextStream
const originalSetTimeout = globalThis.setTimeout

afterEach(() =>
  runtime.run(() => {
    ;(Agent.get as any) = originalAgentGet
    ;(Agent.getAvailableModel as any) = originalAgentModel
    ;(Provider.getModel as any) = originalProviderGetModel
    ;(Provider.resolveRoleModel as any) = originalResolveRoleModel
    ;(LLM.stream as any) = originalStream
    ;(LLM.takeTextStream as any) = originalTakeTextStream
    globalThis.setTimeout = originalSetTimeout
  }),
)

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
  test("resolves an Agent model and collects bounded text without creating a Session", () =>
    runtime.run(async () => {
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
    }))

  test("uses an explicit fallback when the Agent model is unavailable", () =>
    runtime.run(async () => {
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
    }))

  test("uses a requested model role instead of the Agent default", () =>
    runtime.run(async () => {
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
    }))

  test("rejects missing agents and models with stable codes", () =>
    runtime.run(async () => {
      ;(Agent.get as any) = mock(async () => undefined)
      await expect(call()).rejects.toMatchObject({ name: "AgentCallError", code: "agent_not_found" })

      installAgent()
      ;(Agent.getAvailableModel as any) = mock(async () => undefined)
      await expect(call()).rejects.toMatchObject({ name: "AgentCallError", code: "model_unavailable" })
    }))

  test("bounds input and output", () =>
    runtime.run(async () => {
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
    }))

  test("settles timeout and caller cancellation even when a stream stalls", () =>
    runtime.run(async () => {
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
    }))

  test("drains a late-starting stream before returning a timeout", () =>
    runtime.run(async () => {
      installAgent()
      let disposed = false
      let attribution: Parameters<typeof AgentTurn.stream>[0]["recording"]
      using stream = spyOn(AgentTurn, "stream").mockImplementation(async (input) => {
        attribution = input.recording
        await new Promise<void>((resolve) =>
          input.abort.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }),
        )
        return {
          fullStream: (async function* () {})(),
          usage: Promise.resolve(undefined),
          dispose: async () => {
            disposed = true
          },
        }
      })
      await expect(call({ timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" })
      expect(disposed).toBe(true)
      expect((await RolloutLedger.getRun(attribution!.owner, attribution!.runID)).status).toBe("cancelled")
    }))

  test("does not keep the process alive while a call timeout is pending", () =>
    runtime.run(async () => {
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
    }))

  test("disposes its owned text stream after success and failure", () =>
    runtime.run(async () => {
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
    }))

  test("prefers an explicit model override over agent and role resolution", () =>
    runtime.run(async () => {
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
    }))

  test("forwards maxOutputTokens to the stream", () =>
    runtime.run(async () => {
      installAgent()
      let streamInput: Record<string, unknown> | undefined
      ;(LLM.stream as any) = mock(async (input: Record<string, unknown>) => {
        streamInput = input
        return { textStream: (async function* () {})() }
      })
      await call({ maxOutputTokens: 123 })
      expect(streamInput?.maxOutputTokens).toBe(123)
    }))

  test("defaults to small options and forwards an explicit override", () =>
    runtime.run(async () => {
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
    }))

  test("rejects a session call without its causal root instead of inventing a user", () =>
    runtime.run(async () => {
      installAgent()
      let started = false
      ;(LLM.stream as any) = mock(async () => {
        started = true
        return { textStream: (async function* () {})() }
      })
      await expect(call({ sessionId: "session" })).rejects.toMatchObject({ code: "invalid_owner" })
      expect(started).toBe(false)
    }))

  test("returns usage and the resolved model", () =>
    runtime.run(async () => {
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
    }))
})

describe("AgentCall recovery budget", () => {
  test("retries a failed stream with a fresh output buffer and no SDK budget", () =>
    runtime.run(async () => {
      installAgent()
      using delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
      let attempts = 0
      let disposed = 0
      using stream = spyOn(AgentTurn, "stream").mockImplementation(async (input) => {
        expect(input.retries).toBe(0)
        const attempt = ++attempts
        return {
          fullStream: (async function* () {
            yield { type: "text-delta" as const, id: "text", text: attempt === 1 ? "partial" : "complete" }
            if (attempt === 1)
              yield {
                type: "error" as const,
                error: Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEOUT" } }),
              }
          })(),
          usage: Promise.resolve(undefined),
          async dispose() {
            disposed++
          },
        }
      })
      await expect(call()).resolves.toMatchObject({ text: "complete" })
      expect(attempts).toBe(2)
      expect(disposed).toBe(2)
    }))

  test("stream errors consume one shared budget for starts and bodies", () =>
    runtime.run(async () => {
      installAgent()
      using delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
      let attempts = 0
      using stream = spyOn(AgentTurn, "stream").mockImplementation(async () => {
        attempts++
        if (attempts === 1) throw Object.assign(new Error("connect failed"), { code: "ECONNRESET" })
        return {
          fullStream: (async function* () {
            yield { type: "error" as const, error: { type: "overloaded_error" } }
          })(),
          usage: Promise.resolve(undefined),
          async dispose() {},
        }
      })
      await expect(call({ retries: 2 })).rejects.toMatchObject({ type: "overloaded_error" })
      expect(attempts).toBe(3)
    }))

  test("permanent stream failures fail without returning partial text", () =>
    runtime.run(async () => {
      installAgent()
      let attempts = 0
      const failure = Object.assign(new Error("bad key"), { statusCode: 401 })
      using stream = spyOn(AgentTurn, "stream").mockImplementation(async () => {
        attempts++
        return {
          fullStream: (async function* () {
            yield { type: "text-delta" as const, id: "text", text: "partial" }
            yield { type: "error" as const, error: failure }
          })(),
          usage: Promise.resolve(undefined),
          async dispose() {},
        }
      })
      await expect(call()).rejects.toBe(failure)
      expect(attempts).toBe(1)
    }))

  test("the original deadline covers backoff and all attempts", () =>
    runtime.run(async () => {
      installAgent()
      using delay = spyOn(SessionRetry, "delay").mockReturnValue(10_000)
      let attempts = 0
      using stream = spyOn(AgentTurn, "stream").mockImplementation(async () => {
        attempts++
        throw Object.assign(new Error("connect failed"), { code: "ECONNRESET" })
      })
      await expect(call({ timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" })
      expect(attempts).toBe(1)
    }))
})

test("an independent derived call does not append to its terminal source rollout", () =>
  runtime.run(async () => {
    installAgent()
    const { fixture } = await import("../support/rollout")
    const { RolloutContext } = await import("../../src/session/rollout/context")
    await fixture(async ({ rootID, call: source }) => {
      await RolloutLedger.finishCall(source.owner, rootID, source.id, { status: "completed" })
      const terminal = await RolloutLedger.finishRun(source.owner, rootID, "completed")
      const stream = spyOn(LLM, "stream").mockImplementation(
        async () =>
          ({
            textStream: (async function* () {
              yield "derived"
            })(),
          }) as never,
      )
      try {
        await expect(
          RolloutContext.provide({ owner: source.owner, runID: rootID }, () =>
            call({
              ownership: "operation",
              userMetadata: { sourceMessageID: rootID },
            }),
          ),
        ).resolves.toMatchObject({ text: "derived" })
        expect(await RolloutLedger.getRun(source.owner, rootID)).toEqual(terminal)
      } finally {
        stream.mockRestore()
      }
    })
  }))

afterRuntimeTests(() => runtime.close())
