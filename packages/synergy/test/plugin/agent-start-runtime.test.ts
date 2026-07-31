import { describe, expect, test } from "bun:test"
import {
  PluginAgentCallRuntime,
  PluginAgentCallRuntimeError,
  type PluginAgentCallTerminal,
} from "@/plugin/agent-call-runtime"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}

function baseInput(
  run: (signal: AbortSignal) => Promise<{ text: string }>,
  deliver: (call: PluginAgentCallTerminal) => Promise<void>,
) {
  return {
    pluginId: "vibe-lingo",
    pluginGeneration: "generation-one",
    scopeId: "scope-one",
    correlationId: "correction:one",
    inputDigest: "digest-one",
    run,
    deliver,
    mapError(error: unknown) {
      return {
        code:
          error instanceof DOMException && error.name === "AbortError"
            ? "PLUGIN_AGENT_CANCELLED"
            : "PLUGIN_AGENT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }
    },
  }
}

async function settle() {
  for (let attempt = 0; attempt < 20; attempt++) await Bun.sleep(1)
}

describe("PluginAgentCallRuntime", () => {
  test("returns immediately, tracks independently, and delivers one terminal result", async () => {
    const runtime = new PluginAgentCallRuntime()
    const running = deferred<{ text: string }>()
    const delivered: PluginAgentCallTerminal[] = []
    const result = runtime.start(
      baseInput(
        async () => running.promise,
        async (call) => {
          delivered.push(call)
        },
      ),
    )

    expect(result.callId).toBeString()
    expect(runtime.activeCount("vibe-lingo")).toBe(1)
    expect(delivered).toEqual([])

    running.resolve({ text: "metadata" })
    await settle()
    expect(runtime.activeCount()).toBe(0)
    expect(delivered).toEqual([
      expect.objectContaining({
        callId: result.callId,
        correlationId: "correction:one",
        status: "completed",
        text: "metadata",
        startedAt: expect.any(Number),
        completedAt: expect.any(Number),
      }),
    ])
  })

  test("deduplicates identical active correlations and rejects changed content", () => {
    const runtime = new PluginAgentCallRuntime()
    const running = deferred<{ text: string }>()
    const input = baseInput(
      async () => running.promise,
      async () => undefined,
    )
    const first = runtime.start(input)
    expect(runtime.start(input)).toEqual(first)
    expect(() => runtime.start({ ...input, inputDigest: "different" })).toThrow(PluginAgentCallRuntimeError)
    try {
      runtime.start({ ...input, inputDigest: "different" })
    } catch (error) {
      expect(error).toMatchObject({ code: "conflict" })
    }
    expect(runtime.start({ ...input, scopeId: "scope-two" }).callId).not.toBe(first.callId)
    expect(runtime.start({ ...input, pluginGeneration: "generation-two" })).toEqual(first)
  })

  test("enforces a bounded per-plugin concurrency limit without a queue", () => {
    const runtime = new PluginAgentCallRuntime(2)
    const running = deferred<{ text: string }>()
    const input = baseInput(
      async () => running.promise,
      async () => undefined,
    )
    runtime.start(input)
    runtime.start({ ...input, correlationId: "correction:two", inputDigest: "digest-two" })
    expect(() => runtime.start({ ...input, correlationId: "correction:three", inputDigest: "digest-three" })).toThrow(
      "already has 2 active Agent calls",
    )
    expect(runtime.activeCount()).toBe(2)
  })

  test("cancels only the replaced generation and reports a cancelled terminal", async () => {
    const runtime = new PluginAgentCallRuntime()
    const delivered: PluginAgentCallTerminal[] = []
    const result = runtime.start(
      baseInput(
        (signal) => {
          if (signal.aborted) return Promise.reject(signal.reason)
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        },
        async (call) => {
          delivered.push(call)
        },
      ),
    )
    runtime.cancelGeneration("another-plugin", "generation-one")
    expect(runtime.activeCount()).toBe(1)
    runtime.cancelGeneration("vibe-lingo", "generation-two")
    expect(runtime.activeCount()).toBe(1)
    runtime.cancelGeneration("vibe-lingo", "generation-one")
    await settle()
    expect(delivered).toEqual([
      expect.objectContaining({
        callId: result.callId,
        status: "cancelled",
        error: {
          code: "PLUGIN_AGENT_CANCELLED",
          message: "Plugin generation stopped",
        },
      }),
    ])
  })

  test("releases capacity on cancellation even when a provider ignores abort", async () => {
    const runtime = new PluginAgentCallRuntime(1)
    const running = deferred<{ text: string }>()
    const delivered: PluginAgentCallTerminal[] = []
    runtime.start(
      baseInput(
        async () => running.promise,
        async (call) => {
          delivered.push(call)
        },
      ),
    )

    runtime.cancelGeneration("vibe-lingo", "generation-one", "Plugin disabled")
    expect(runtime.activeCount("vibe-lingo")).toBe(0)
    expect(
      runtime.start({
        ...baseInput(
          async () => Promise.resolve({ text: "new" }),
          async () => undefined,
        ),
        correlationId: "correction:new",
        inputDigest: "digest-new",
      }).callId,
    ).toBeString()
    await settle()
    expect(delivered).toEqual([
      expect.objectContaining({
        status: "cancelled",
        error: {
          code: "PLUGIN_AGENT_CANCELLED",
          message: "Plugin disabled",
        },
      }),
    ])
  })

  test("cancels only calls owned by the disabled Scope", async () => {
    const runtime = new PluginAgentCallRuntime()
    const running = deferred<{ text: string }>()
    const delivered: Array<{ scopeId: string; call: PluginAgentCallTerminal }> = []
    const input = baseInput(
      async () => running.promise,
      async (call) => {
        delivered.push({ scopeId: "scope-one", call })
      },
    )
    runtime.start(input)
    runtime.start({
      ...input,
      scopeId: "scope-two",
      correlationId: "correction:two",
      inputDigest: "digest-two",
      deliver: async (call) => {
        delivered.push({ scopeId: "scope-two", call })
      },
    })

    await runtime.disableScope("scope-one")
    expect(runtime.activeCount()).toBe(1)
    expect(delivered).toEqual([
      {
        scopeId: "scope-one",
        call: expect.objectContaining({ status: "cancelled" }),
      },
    ])

    running.resolve({ text: "kept" })
    await settle()
    expect(delivered).toEqual([
      {
        scopeId: "scope-one",
        call: expect.objectContaining({ status: "cancelled" }),
      },
      {
        scopeId: "scope-two",
        call: expect.objectContaining({ status: "completed", text: "kept" }),
      },
    ])
  })

  test("releases Scope capacity before terminal delivery completes", async () => {
    const runtime = new PluginAgentCallRuntime(1)
    const running = deferred<{ text: string }>()
    const delivery = deferred<void>()
    runtime.start(
      baseInput(
        async () => running.promise,
        async () => delivery.promise,
      ),
    )

    const disabled = runtime.disableScope("scope-one")
    expect(runtime.activeCount()).toBe(0)
    runtime.enableScope("scope-one")
    expect(
      runtime.start({
        ...baseInput(
          async () => Promise.resolve({ text: "new" }),
          async () => undefined,
        ),
        correlationId: "correction:new",
        inputDigest: "digest-new",
      }).callId,
    ).toBeString()
    delivery.resolve()
    await disabled
  })

  test("keeps a disabled Scope cancelled when its provider settles late", async () => {
    const runtime = new PluginAgentCallRuntime()
    const running = deferred<{ text: string }>()
    const delivered: PluginAgentCallTerminal[] = []
    runtime.start(
      baseInput(
        async () => running.promise,
        async (call) => {
          delivered.push(call)
        },
      ),
    )

    await runtime.disableScope("scope-one")
    running.resolve({ text: "late" })
    await settle()
    expect(delivered.map((call) => call.status)).toEqual(["cancelled"])
  })

  test("rejects disabled Scopes until explicitly enabled", () => {
    const runtime = new PluginAgentCallRuntime()
    runtime.disableScope("scope-one")
    expect(() =>
      runtime.start(
        baseInput(
          async () => Promise.resolve({ text: "blocked" }),
          async () => undefined,
        ),
      ),
    ).toThrow(PluginAgentCallRuntimeError)
    try {
      runtime.start(
        baseInput(
          async () => Promise.resolve({ text: "blocked" }),
          async () => undefined,
        ),
      )
    } catch (error) {
      expect(error).toMatchObject({ code: "cancelled" })
    }

    runtime.enableScope("scope-one")
    expect(
      runtime.start(
        baseInput(
          async () => Promise.resolve({ text: "accepted" }),
          async () => undefined,
        ),
      ).callId,
    ).toBeString()
  })
})
