import { expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { InProcessModelExecutor } from "../../src/session/agent-turn/model-executor"
import type { AgentTurnPoolInput } from "../../src/session/agent-turn/worker-pool"
import type { LLM } from "../../src/session/llm"

function input(signal = new AbortController().signal): AgentTurnPoolInput {
  return {
    abort: signal,
    sessionID: crypto.randomUUID(),
    user: { id: "msg_test" },
    agent: { name: "test" },
    messages: [{ role: "user", content: "hello" }],
    system: [],
    toolDefinitions: [],
    prepared: { system: [], params: { options: {} }, provider: { options: {} }, baseSystemLength: 0 },
  } as unknown as AgentTurnPoolInput
}

function fixture(options = { size: 1, maxQueued: 1, maxQueuedBytes: 4096 }) {
  const calls: Array<{
    signal: AbortSignal
    output: ReadableStreamDefaultController<never>
    cancelled: PromiseWithResolvers<void>
  }> = []
  const executor = new InProcessModelExecutor(options, async (request) => {
    const cancelled = Promise.withResolvers<void>()
    const stream = new ReadableStream<never>({
      start(output) {
        calls.push({ signal: request.abort, output, cancelled })
      },
      cancel() {
        return cancelled.promise
      },
    })
    return { fullStream: stream, usage: Promise.resolve(undefined) } as unknown as LLM.StreamOutput
  })
  return { executor, calls }
}

test("holds capacity until the stream is consumed and rejects excess waiting calls", async () => {
  const { executor, calls } = fixture()
  const first = await executor.run(input())
  const next = executor.run(input())
  await expect(executor.run(input())).rejects.toThrow("queue is full")
  expect(calls).toHaveLength(1)
  expect(executor.stats()).toMatchObject({ active: 1, queued: 1, workers: 0 })
  calls[0]!.output.close()
  for await (const part of first.fullStream) void part
  await first.dispose()
  const second = await next
  expect(calls).toHaveLength(2)
  calls[1]!.output.close()
  for await (const part of second.fullStream) void part
  await executor.stop()
  expect(executor.stats()).toMatchObject({ active: 0, queued: 0, queuedBytes: 0 })
})

test("queued cancellation releases count and bytes without starting a provider call", async () => {
  const { executor, calls } = fixture()
  await executor.run(input())
  const controller = new AbortController()
  const pending = executor.run(input(controller.signal))
  expect(executor.stats().queuedBytes).toBeGreaterThan(0)
  controller.abort(new Error("cancel queued"))
  await expect(pending).rejects.toThrow("cancel queued")
  expect(executor.stats()).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 })
  expect(calls).toHaveLength(1)
  calls[0]!.cancelled.resolve()
  await executor.stop()
})

test("shutdown aborts active streams but waits for actual provider disposal", async () => {
  const { executor, calls } = fixture()
  await executor.run(input())
  const queued = executor.run(input())
  let stopped = false
  const stopping = executor.stop().then(() => (stopped = true))
  await expect(queued).rejects.toThrow("stopping")
  expect(calls[0]!.signal.aborted).toBe(true)
  await Promise.resolve()
  expect(stopped).toBe(false)
  await expect(executor.run(input())).rejects.toThrow("stopping")
  calls[0]!.cancelled.resolve()
  await stopping
  expect(executor.stats().active).toBe(0)
})

test("cancellation during provider initialization does not admit another call early", async () => {
  const opened = Promise.withResolvers<LLM.StreamOutput>()
  const cancelled = Promise.withResolvers<void>()
  const executor = new InProcessModelExecutor({ size: 1, maxQueued: 1, maxQueuedBytes: 4096 }, () => opened.promise)
  const controller = new AbortController()
  const pending = executor.run(input(controller.signal))
  controller.abort(new Error("cancel initializing"))
  const stopping = executor.stop()
  expect(executor.stats().active).toBe(1)
  opened.resolve({
    fullStream: new ReadableStream({ cancel: () => cancelled.promise }),
    usage: Promise.resolve(undefined),
  } as unknown as LLM.StreamOutput)
  await Promise.resolve()
  cancelled.resolve()
  await expect(pending).rejects.toThrow("cancel initializing")
  await stopping
  expect(executor.stats().active).toBe(0)
})

test("bounds retained bytes and validates finite capacity", async () => {
  expect(() => fixture({ size: 0, maxQueued: 1, maxQueuedBytes: 4096 })).toThrow("positive")
  expect(() => fixture({ size: 1, maxQueued: -1, maxQueuedBytes: 4096 })).toThrow("non-negative")
  const { executor } = fixture({ size: 1, maxQueued: 8, maxQueuedBytes: 64 })
  await expect(executor.run(input())).rejects.toThrow("bytes")
  expect(executor.stats()).toMatchObject({ active: 0, queued: 0 })
  await executor.stop()
})

test("queued calls retain their originating asynchronous identity context", async () => {
  const identity = new AsyncLocalStorage<string>()
  const seen: Array<string | undefined> = []
  const outputs: ReadableStreamDefaultController<never>[] = []
  const executor = new InProcessModelExecutor({ size: 1, maxQueued: 1, maxQueuedBytes: 4096 }, async () => {
    seen.push(identity.getStore())
    return {
      fullStream: new ReadableStream<never>({
        start(output) {
          outputs.push(output)
        },
      }),
      usage: Promise.resolve(undefined),
    } as unknown as LLM.StreamOutput
  })
  const first = await identity.run("first", () => executor.run(input()))
  const next = identity.run("second", () => executor.run(input()))
  outputs[0]!.close()
  for await (const part of first.fullStream) void part
  const second = await next
  expect(seen).toEqual(["first", "second"])
  outputs[1]!.close()
  for await (const part of second.fullStream) void part
  await executor.stop()
})

test("usage is not read until the consumer drains the stream", async () => {
  let reads = 0
  let pulls = 0
  const executor = new InProcessModelExecutor(
    { size: 1, maxQueued: 1, maxQueuedBytes: 4096 },
    async () =>
      ({
        fullStream: new ReadableStream({
          pull(output) {
            pulls++
            if (pulls === 4) output.close()
            else output.enqueue({ type: "text-delta", id: "text", text: "hi" })
          },
        }),
        get usage() {
          reads++
          return Promise.resolve({ inputTokens: 1, outputTokens: 3 })
        },
      }) as unknown as LLM.StreamOutput,
  )
  const stream = await executor.run(input())
  await Promise.resolve()
  expect(reads).toBe(0)
  expect(pulls).toBe(1)
  for await (const part of stream.fullStream) void part
  expect(reads).toBe(1)
  expect(await stream.usage).toMatchObject({ outputTokens: 3 })
  await executor.stop()
})

test("an unconfirmed disposal remains a shutdown failure", async () => {
  const executor = new InProcessModelExecutor(
    { size: 1, maxQueued: 1, maxQueuedBytes: 4096 },
    async () =>
      ({
        fullStream: new ReadableStream({
          cancel() {
            throw new Error("provider disposal failed")
          },
        }),
        usage: Promise.resolve(undefined),
      }) as unknown as LLM.StreamOutput,
  )
  const stream = await executor.run(input())
  await expect(stream.dispose()).rejects.toThrow("provider disposal failed")
  await expect(executor.run(input())).rejects.toThrow("stopping")
  await expect(executor.stop()).rejects.toThrow("failed to stop")
})

test.each(["read", "dispose", "abort"] as const)(
  "a terminal upstream stream error releases capacity after %s",
  async (action) => {
    const { executor, calls } = fixture()
    const controller = new AbortController()
    const first = await executor.run(input(controller.signal))
    const pending = executor.run(input())
    const failure = new Error("upstream connection lost")
    calls[0]!.output.error(failure)
    if (action === "read") {
      await expect(
        (async () => {
          for await (const part of first.fullStream) void part
        })(),
      ).rejects.toBe(failure)
    } else if (action === "dispose") await first.dispose()
    else controller.abort(new Error("caller cancelled"))
    const second = await pending
    expect(await first.usage).toBeUndefined()
    expect(executor.stats()).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 })
    calls[1]!.output.close()
    for await (const part of second.fullStream) void part
    await executor.stop()
    expect(executor.stats().active).toBe(0)
  },
)
