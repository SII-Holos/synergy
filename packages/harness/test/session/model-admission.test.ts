import { expect, test } from "bun:test"
import { AgentTurn } from "../../src/session/agent-turn"
import { RuntimeResources } from "../../src/resources/runtime"
import { testRuntime } from "../support/runtime"

function request(operationID: string, signal = new AbortController().signal): AgentTurn.Input {
  return {
    sessionID: operationID,
    abort: signal,
    user: { id: "msg_request" },
    agent: { name: "fixture" },
    model: {
      id: "fixture",
      providerID: "fixture",
      api: { id: "fixture", npm: "fixture" },
      limit: { context: 4096, output: 1024 },
    },
    recording: { owner: { kind: "operation", scopeID: "home", operationID }, runID: operationID, purpose: "test" },
    messages: [{ role: "user", content: "hello" }],
    system: [],
    toolDefinitions: [],
    prepared: { system: [], baseSystemLength: 0, params: { options: {} }, provider: { options: {} } },
  } as unknown as AgentTurn.Input
}

test("shared admission keeps model work queued until actual stream disposal and cancels without invoking the provider", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    AgentTurn.configure({ size: 1, minIdle: 0 })
    let calls = 0
    const dispose = Promise.withResolvers<void>()
    AgentTurn.setInProcessStream(async () => {
      calls++
      return {
        fullStream: (async function* () {})(),
        usage: Promise.resolve(undefined),
        dispose: () => dispose.promise,
      }
    })
    const first = await AgentTurn.stream(request(crypto.randomUUID()))
    const abort = new AbortController()
    const second = AgentTurn.stream(request(crypto.randomUUID(), abort.signal))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toBe(1)
    expect(AgentTurn.stats()).toMatchObject({ active: 1, queued: 1 })
    const disposing = first.dispose()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(AgentTurn.stats().active).toBe(1)
    abort.abort(new Error("cancel queued model"))
    await expect(second).rejects.toThrow("cancel queued model")
    dispose.resolve()
    await disposing
    expect(AgentTurn.stats()).toMatchObject({ active: 0, queued: 0 })
    expect(calls).toBe(1)
  })
})

test("a tight real-capacity snapshot blocks request preparation without a model retry", async () => {
  await using runtime = await testRuntime({
    resources: {
      sample: async () => ({
        sampledAt: Date.now(),
        quality: "complete",
        pressure: "normal",
        processRssBytes: 0,
        domains: [{ kind: "physical", capacityBytes: 8 * 1024 ** 3, availableBytes: 64 * 1024 ** 2 }],
      }),
    },
  })
  await runtime.run(async () => {
    const abort = new AbortController()
    let entered = false
    const work = RuntimeResources.allocation(
      { owner: "root", bytes: 256 * 1024 ** 2, signal: abort.signal },
      async () => {
        entered = true
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(entered).toBe(false)
    expect(RuntimeResources.status()).toMatchObject({ reason: "headroom", queued: 1 })
    abort.abort(new Error("cancel preparation"))
    await expect(work).rejects.toThrow("cancel preparation")
    expect(entered).toBe(false)
  })
})
