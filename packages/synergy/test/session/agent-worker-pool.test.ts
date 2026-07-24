import { describe, expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { AgentTurnProtocol } from "../../src/session/agent-turn/protocol"
import { AgentWorkerPool, type AgentWorkerPoolOptions } from "../../src/session/agent-turn/worker-pool"
import type { AgentWorkerProcess, SpawnAgentWorkerProcessOptions } from "../../src/session/agent-turn/process-host"

interface FakeWorker {
  options: SpawnAgentWorkerProcessOptions
  sent: AgentTurnProtocol.HostToWorker[]
  host: AgentWorkerProcess
  stops: number
  ready(): void
  receive(message: AgentTurnProtocol.WorkerToHost): void
  exit(code?: number | null, signal?: string | null): void
}

function workerMemory(rssBytes = 1, heapUsedBytes = 1, externalBytes = 1): AgentTurnProtocol.WorkerMemory {
  return {
    rssBytes,
    heapUsedBytes,
    heapTotalBytes: heapUsedBytes + 1,
    externalBytes,
    arrayBuffersBytes: 1,
  }
}

function fakeWorkers() {
  const workers: FakeWorker[] = []
  const spawn = (options: SpawnAgentWorkerProcessOptions): AgentWorkerProcess => {
    const sent: AgentTurnProtocol.HostToWorker[] = []
    const host = {
      process: {
        exitCode: null,
        kill() {
          options.onExit(null, "SIGTERM")
        },
      } as unknown as Bun.Subprocess,
      send(message: AgentTurnProtocol.HostToWorker) {
        sent.push(message)
      },
      async stop() {
        worker.stops += 1
        options.onExit(0, null)
      },
    }
    const worker: FakeWorker = {
      options,
      sent,
      host,
      stops: 0,
      ready() {
        options.onMessage({
          type: "ready",
          protocolVersion: AgentTurnProtocol.VERSION,
          pid: 1000 + workers.indexOf(worker),
          memory: workerMemory(),
        })
      },
      receive(message) {
        options.onMessage(message)
      },
      exit(code = 1, signal = null) {
        options.onExit(code, signal)
      },
    }
    workers.push(worker)
    return host
  }
  return { workers, spawn }
}

function startTurn(worker: FakeWorker) {
  const start = worker.sent.findLast(
    (message): message is Extract<AgentTurnProtocol.HostToWorker, { type: "run-start" }> =>
      message.type === "run-start",
  )!
  worker.receive({ type: "run-ready", requestId: start.requestId })
  for (let index = 0; index < start.chunkCount; index++) {
    expect(
      worker.sent.some(
        (message) => message.type === "run-chunk" && message.requestId === start.requestId && message.index === index,
      ),
    ).toBe(true)
    worker.receive({ type: "chunk-ack", requestId: start.requestId, index })
  }
  expect(worker.sent).toContainEqual({ type: "run-commit", requestId: start.requestId })
  return start
}

function releaseTurn(worker: FakeWorker, requestId: string, turns = 1, memory = workerMemory()) {
  worker.receive({
    type: "released",
    requestId,
    turns,
    collection: "full",
    memory,
  })
}

const options: AgentWorkerPoolOptions = {
  size: 1,
  minIdle: 0,
  idleTimeoutMs: 60_000,
  maxQueued: 8,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxTurns: 64,
  maxRssBytes: 1024 * 1024 * 1024,
  maxHeapBytes: 768 * 1024 * 1024,
  idleBaselineRecycle: true,
  idleBaselineRssGrowthBytes: 256,
  idleBaselineExternalGrowthBytes: 128,
  cancelGraceMs: 10,
  heartbeatTimeoutMs: 60_000,
}

function input(abort: AbortSignal) {
  return {
    abort,
    sessionID: "ses_test",
    user: { id: "msg_user" },
    model: { id: "model", providerID: "provider" },
    agent: { name: "synergy" },
    toolDefinitions: [],
    messages: [],
    system: [],
    prepared: {
      system: [],
      baseSystemLength: 0,
      provider: {
        options: {},
        timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
      },
      params: { options: {} },
    },
  } as any
}

async function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

describe("AgentWorkerPool", () => {
  test("rejects an idle reserve larger than the worker concurrency limit", () => {
    expect(() => new AgentWorkerPool({ ...options, size: 1, minIdle: 2 }, fakeWorkers().spawn)).toThrow("minIdle")
  })

  test("scales workers with concurrent demand instead of filling the pool eagerly", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 3 }, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))

    expect(fake.workers).toHaveLength(1)
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    const first = await firstPromise

    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))
    expect(fake.workers).toHaveLength(2)
    fake.workers[1].ready()
    const secondRun = startTurn(fake.workers[1])
    fake.workers[1].receive({ type: "started", requestId: secondRun.requestId })
    const second = await secondPromise

    for (const [worker, run] of [
      [fake.workers[0], firstRun],
      [fake.workers[1], secondRun],
    ] as const) {
      worker.receive({
        type: "complete",
        requestId: run.requestId,
        turns: 1,
        memoryBeforeDispose: workerMemory(2, 2),
        memory: workerMemory(),
      })
      releaseTurn(worker, run.requestId)
    }
    expect((await first.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(pool.stats()).toMatchObject({ configured: 3, workers: 2, active: 0 })
    await pool.stop()
  })

  test("retires all workers after the idle timeout when the warm reserve is zero", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 2, minIdle: 0, idleTimeoutMs: 10 }, fake.spawn)
    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    const stream = await streamPromise
    fake.workers[0].receive({
      type: "complete",
      requestId: run.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    releaseTurn(fake.workers[0], run.requestId)
    expect((await stream.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)

    await Bun.sleep(40)

    expect(pool.stats()).toMatchObject({ configured: 2, workers: 0, ready: 0, active: 0 })
    await pool.stop()
  })

  test("preserves the configured warm reserve after excess workers time out", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 2, minIdle: 1, idleTimeoutMs: 10 }, fake.spawn)
    expect(fake.workers).toHaveLength(1)

    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    expect(fake.workers).toHaveLength(2)
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    fake.workers[1].ready()
    const stream = await streamPromise
    fake.workers[0].receive({
      type: "complete",
      requestId: run.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    releaseTurn(fake.workers[0], run.requestId)
    expect((await stream.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)

    await Bun.sleep(40)

    expect(pool.stats()).toMatchObject({ configured: 2, minIdle: 1, workers: 1, ready: 1, active: 0 })
    await pool.stop()
  })

  test("acknowledges a frame only after its final event has been consumed", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    const stream = await streamPromise
    fake.workers[0].receive({
      type: "events",
      requestId: run.requestId,
      sequence: 1,
      events: [
        { type: "text-delta", id: "text", text: "a" },
        { type: "text-delta", id: "text", text: "b" },
      ],
    })

    const iterator = stream.fullStream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ text: "a" })
    expect(fake.workers[0].sent.some((message) => message.type === "ack")).toBe(false)
    expect((await iterator.next()).value).toMatchObject({ text: "b" })
    expect(fake.workers[0].sent.some((message) => message.type === "ack")).toBe(false)

    const done = iterator.next()
    await Bun.sleep(0)
    expect(fake.workers[0].sent).toContainEqual({
      type: "ack",
      requestId: run.requestId,
      sequence: 1,
    })
    fake.workers[0].receive({
      type: "complete",
      requestId: run.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    expect((await done).done).toBe(true)
    await pool.stop()
  })

  test("serializes only the worker-owned user, Agent, and prompt fields", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const streamPromise = inScope(() =>
      pool.run({
        ...input(new AbortController().signal),
        user: { id: "msg_user", system: "control-plane-only" },
        agent: { name: "synergy", prompt: "control-plane-only", permission: [] },
        system: ["already folded into prepared.system"],
        prepared: {
          system: ["prepared"],
          baseSystemLength: 1,
          provider: {
            options: {},
            timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
          },
          params: { options: {} },
        },
      } as any),
    )
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    const chunks = fake.workers[0].sent
      .filter(
        (message): message is Extract<AgentTurnProtocol.HostToWorker, { type: "run-chunk" }> =>
          message.type === "run-chunk" && message.requestId === run.requestId,
      )
      .map((message) => message.data)
    const envelope = AgentTurnProtocol.deserializeTurn(Buffer.concat(chunks))

    expect(envelope.input.user).toEqual({ id: "msg_user" })
    expect(envelope.input.agent).toEqual({ name: "synergy" })
    expect(envelope.input.system).toEqual([])
    expect(envelope.input.prepared.system).toEqual(["prepared"])

    fake.workers[0].receive({
      type: "error",
      requestId: run.requestId,
      error: { name: "Error", message: "stop" },
    })
    await expect(streamPromise).rejects.toThrow("stop")
    await pool.stop()
  })

  test("fails only the owned turn and replaces a crashed worker on the next demand", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    const first = await firstPromise
    fake.workers[0].exit(9)

    const iterator = first.fullStream[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow("Agent worker exited")
    expect(fake.workers).toHaveLength(1)

    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))
    expect(fake.workers).toHaveLength(2)
    fake.workers[1].ready()
    const secondRun = startTurn(fake.workers[1])
    fake.workers[1].receive({ type: "started", requestId: secondRun.requestId })
    fake.workers[1].receive({
      type: "complete",
      requestId: secondRun.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    const second = await secondPromise
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    await pool.stop()
  })

  test("backs off repeated startup failures and opens the circuit after the sixth attempt", async () => {
    const fake = fakeWorkers()
    const delays: number[] = []
    const pool = new AgentWorkerPool(options, fake.spawn, {
      startupBackoffBaseMs: 100,
      startupBackoffMaxMs: 1_600,
      maxConsecutiveStartupFailures: 5,
      sleep(ms) {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    const turn = inScope(() => pool.run(input(new AbortController().signal))).catch((error) => error)

    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        fake.workers[attempt].exit(1)
        await Bun.sleep(0)
      }

      expect(delays).toEqual([100, 200, 400, 800, 1_600])
      expect(await turn).toMatchObject({
        message: "Agent worker failed to start after 6 consecutive attempts",
      })
      const spawned = fake.workers.length
      await expect(inScope(() => pool.run(input(new AbortController().signal)))).rejects.toThrow(
        "Agent worker failed to start after 6 consecutive attempts",
      )
      expect(fake.workers).toHaveLength(spawned)
    } finally {
      await pool.stop()
    }
  })

  test("reschedules startup backoff from the latest concurrent failure", async () => {
    const fake = fakeWorkers()
    const delays: number[] = []
    const retries: Array<() => void> = []
    const pool = new AgentWorkerPool({ ...options, size: 3, minIdle: 2 }, fake.spawn, {
      startupBackoffBaseMs: 100,
      startupBackoffMaxMs: 1_600,
      maxConsecutiveStartupFailures: 5,
      sleep(ms) {
        delays.push(ms)
        return new Promise<void>((resolve) => retries.push(resolve))
      },
    })
    const turn = inScope(() => pool.run(input(new AbortController().signal))).catch((error) => error)

    try {
      fake.workers.slice(0, 3).forEach((worker) => worker.exit(1))
      expect(delays).toEqual([100, 200, 400])

      retries[0]()
      await Bun.sleep(0)
      expect(fake.workers).toHaveLength(3)
      retries[1]()
      await Bun.sleep(0)
      expect(fake.workers).toHaveLength(3)
      retries[2]()
      await Bun.sleep(0)
      expect(fake.workers).toHaveLength(6)

      fake.workers.slice(3, 6).forEach((worker) => worker.exit(1))
      expect(delays).toEqual([100, 200, 400, 800, 1_600])
      expect(await turn).toMatchObject({
        message: "Agent worker failed to start after 6 consecutive attempts",
      })
    } finally {
      await pool.stop()
    }
  })

  test("replaces a startup protocol violation without counting it as a startup failure", async () => {
    const fake = fakeWorkers()
    const delays: number[] = []
    const pool = new AgentWorkerPool(options, fake.spawn, {
      startupBackoffBaseMs: 100,
      sleep(ms) {
        delays.push(ms)
        return Promise.resolve()
      },
    })
    const turn = inScope(() => pool.run(input(new AbortController().signal)))

    try {
      fake.workers[0].receive({ type: "ready", protocolVersion: 0, pid: 1000, memory: workerMemory() })
      expect(delays).toEqual([])
      expect(fake.workers).toHaveLength(2)

      fake.workers[1].ready()
      const run = startTurn(fake.workers[1])
      fake.workers[1].receive({
        type: "error",
        requestId: run.requestId,
        error: { name: "Error", message: "stop" },
      })
      await expect(turn).rejects.toThrow("stop")
    } finally {
      await pool.stop()
      await turn.catch(() => undefined)
    }
  })

  test("recovers an open startup circuit when an existing worker completes its handshake", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 2, minIdle: 1 }, fake.spawn, {
      startupBackoffBaseMs: 100,
      startupBackoffMaxMs: 1_600,
      maxConsecutiveStartupFailures: 5,
      sleep() {
        return Promise.resolve()
      },
    })
    const failedTurn = inScope(() => pool.run(input(new AbortController().signal))).catch((error) => error)

    try {
      for (let attempt = 1; attempt <= 6; attempt++) {
        fake.workers[attempt].exit(1)
        await Bun.sleep(0)
      }
      expect(await failedTurn).toMatchObject({
        message: "Agent worker failed to start after 6 consecutive attempts",
      })

      fake.workers[0].ready()
      const recoveredTurn = inScope(() => pool.run(input(new AbortController().signal)))
      const run = startTurn(fake.workers[0])
      fake.workers[0].receive({ type: "started", requestId: run.requestId })
      fake.workers[0].receive({
        type: "complete",
        requestId: run.requestId,
        turns: 1,
        memoryBeforeDispose: workerMemory(2, 2),
        memory: workerMemory(),
      })
      const stream = await recoveredTurn
      expect((await stream.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    } finally {
      await pool.stop()
    }
  })

  test("contains an event-frame backpressure protocol violation to one worker", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    const stream = await streamPromise
    fake.workers[0].receive({
      type: "events",
      requestId: run.requestId,
      sequence: 1,
      events: [{ type: "text-delta", id: "text", text: "first" }],
    })
    fake.workers[0].receive({
      type: "events",
      requestId: run.requestId,
      sequence: 2,
      events: [{ type: "text-delta", id: "text", text: "second" }],
    })

    await expect(stream.fullStream[Symbol.asyncIterator]().next()).rejects.toThrow()
    expect(fake.workers).toHaveLength(1)
    await pool.stop()
  })

  test("contains a message for an unowned request to one worker", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    const stream = await streamPromise

    fake.workers[0].receive({
      type: "events",
      requestId: "unowned",
      sequence: 1,
      events: [],
    })

    await expect(stream.fullStream[Symbol.asyncIterator]().next()).rejects.toThrow("Agent worker exited")
    expect(fake.workers).toHaveLength(1)
    await pool.stop()
  })

  test("waits for release before recycling a completed worker or assigning the next turn", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, maxTurns: 1 }, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    const first = await firstPromise
    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))

    fake.workers[0].receive({
      type: "complete",
      requestId: firstRun.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    expect((await first.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers).toHaveLength(1)
    expect(fake.workers[0].sent.filter((message) => message.type === "run-start")).toHaveLength(1)

    releaseTurn(fake.workers[0], firstRun.requestId)
    expect(fake.workers).toHaveLength(2)
    expect(pool.stats().workers).toBe(1)
    expect(fake.workers[0].sent.filter((message) => message.type === "run-start")).toHaveLength(1)

    fake.workers[1].ready()
    const secondRun = startTurn(fake.workers[1])
    fake.workers[1].receive({ type: "started", requestId: secondRun.requestId })
    fake.workers[1].receive({
      type: "complete",
      requestId: secondRun.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    releaseTurn(fake.workers[1], secondRun.requestId)
    const second = await secondPromise
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    await pool.stop()
  })

  test("recycles only after post-GC idle memory grows beyond its warm baseline", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(
      {
        ...options,
        maxTurns: 64,
        maxRssBytes: 10_000,
        maxHeapBytes: 10_000,
        idleBaselineRssGrowthBytes: 256,
      },
      fake.spawn,
    )
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    fake.workers[0].receive({
      type: "complete",
      requestId: firstRun.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(200, 100),
      memory: workerMemory(100, 100),
    })
    releaseTurn(fake.workers[0], firstRun.requestId, 1, workerMemory(100, 100))
    const first = await firstPromise
    expect((await first.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers).toHaveLength(1)

    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))
    const secondRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: secondRun.requestId })
    fake.workers[0].receive({
      type: "complete",
      requestId: secondRun.requestId,
      turns: 2,
      memoryBeforeDispose: workerMemory(500, 100),
      memory: workerMemory(357, 100),
    })
    releaseTurn(fake.workers[0], secondRun.requestId, 2, workerMemory(357, 100))
    const second = await secondPromise
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers).toHaveLength(1)
    expect(pool.stats().workers).toBe(0)
    await pool.stop()
  })

  test("leaves baseline recycling disabled when configured off", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(
      {
        ...options,
        idleBaselineRecycle: false,
        maxRssBytes: 10_000,
        maxHeapBytes: 10_000,
      },
      fake.spawn,
    )
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    fake.workers[0].receive({
      type: "complete",
      requestId: firstRun.requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(200, 100),
      memory: workerMemory(100, 100),
    })
    releaseTurn(fake.workers[0], firstRun.requestId, 1, workerMemory(100, 100))
    const first = await firstPromise
    expect((await first.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)

    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))
    const secondRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: secondRun.requestId })
    fake.workers[0].receive({
      type: "complete",
      requestId: secondRun.requestId,
      turns: 2,
      memoryBeforeDispose: workerMemory(500, 100),
      memory: workerMemory(500, 100),
    })
    releaseTurn(fake.workers[0], secondRun.requestId, 2, workerMemory(500, 100))
    const second = await secondPromise
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers).toHaveLength(1)
    await pool.stop()
  })

  test("removes an aborted queued turn without terminating the busy worker", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    await firstPromise

    const queuedAbort = new AbortController()
    const queued = inScope(() => pool.run(input(queuedAbort.signal)))
    queuedAbort.abort()
    await expect(queued).rejects.toBeDefined()
    expect(fake.workers[0].sent.some((message) => message.type === "cancel")).toBe(false)
    await pool.stop()
  })

  test("bounds aggregate waiting-turn bytes independently from active work", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, maxQueuedBytes: 2_048 }, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    await firstPromise

    await expect(
      inScope(() =>
        pool.run({
          ...input(new AbortController().signal),
          prepared: {
            system: ["x".repeat(4_096)],
            baseSystemLength: 1,
            provider: {
              options: {},
              timeouts: { ttfbMs: 10, idleMs: 20, wallMs: false as const },
            },
            params: { options: {} },
          },
        }),
      ),
    ).rejects.toThrow("queue exceeded")
    await pool.stop()
  })

  test("admits queued demand immediately after raising the worker ceiling", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool(options, fake.spawn)
    const firstPromise = inScope(() => pool.run(input(new AbortController().signal)))
    expect(fake.workers).toHaveLength(1)
    fake.workers[0].ready()
    const firstRun = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: firstRun.requestId })
    const first = await firstPromise

    const secondPromise = inScope(() => pool.run(input(new AbortController().signal)))
    expect(fake.workers).toHaveLength(1)
    expect(pool.stats()).toMatchObject({ configured: 1, workers: 1, active: 1, queued: 1 })

    pool.resize(2)

    expect(fake.workers).toHaveLength(2)
    expect(pool.stats()).toMatchObject({
      configured: 2,
      workers: 2,
      active: 1,
      queued: 1,
    })

    fake.workers[1].ready()
    const secondRun = startTurn(fake.workers[1])
    fake.workers[1].receive({ type: "started", requestId: secondRun.requestId })
    const second = await secondPromise

    for (const [worker, run] of [
      [fake.workers[0], firstRun],
      [fake.workers[1], secondRun],
    ] as const) {
      worker.receive({
        type: "complete",
        requestId: run.requestId,
        turns: 1,
        memoryBeforeDispose: workerMemory(2, 2),
        memory: workerMemory(),
      })
      releaseTurn(worker, run.requestId)
    }
    expect((await first.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect((await second.fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    await pool.stop()
  })

  test("shrinks by releasing idle workers without stopping an active turn", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 3 }, fake.spawn)
    const streamPromises = Array.from({ length: 3 }, () => inScope(() => pool.run(input(new AbortController().signal))))
    expect(fake.workers).toHaveLength(3)
    for (const worker of fake.workers) worker.ready()
    const runs = fake.workers.map((worker) => startTurn(worker))
    for (const [index, worker] of fake.workers.entries()) {
      worker.receive({ type: "started", requestId: runs[index].requestId })
    }
    const streams = await Promise.all(streamPromises)
    for (const index of [1, 2]) {
      fake.workers[index].receive({
        type: "complete",
        requestId: runs[index].requestId,
        turns: 1,
        memoryBeforeDispose: workerMemory(2, 2),
        memory: workerMemory(),
      })
      releaseTurn(fake.workers[index], runs[index].requestId)
      expect((await streams[index].fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    }

    pool.resize(1)

    expect(fake.workers[0].stops).toBe(0)
    expect(fake.workers[1].stops).toBe(1)
    expect(fake.workers[2].stops).toBe(1)
    expect(pool.stats()).toMatchObject({
      configured: 1,
      workers: 1,
      active: 1,
    })

    fake.workers[0].receive({
      type: "complete",
      requestId: runs[0].requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    releaseTurn(fake.workers[0], runs[0].requestId)
    expect((await streams[0].fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    await pool.stop()
  })

  test("retires excess active workers only after their turns are released", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, size: 3 }, fake.spawn)
    const streamPromises = Array.from({ length: 3 }, () => inScope(() => pool.run(input(new AbortController().signal))))
    expect(fake.workers).toHaveLength(3)
    for (const worker of fake.workers) worker.ready()
    const runs = fake.workers.map((worker) => startTurn(worker))
    for (const [index, worker] of fake.workers.entries()) {
      worker.receive({ type: "started", requestId: runs[index].requestId })
    }
    const streams = await Promise.all(streamPromises)

    pool.resize(1)

    expect(fake.workers.map((worker) => worker.stops)).toEqual([0, 0, 0])
    expect(pool.stats()).toMatchObject({
      configured: 1,
      workers: 3,
      active: 3,
    })

    fake.workers[0].receive({
      type: "complete",
      requestId: runs[0].requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    expect((await streams[0].fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers[0].stops).toBe(0)
    releaseTurn(fake.workers[0], runs[0].requestId)
    expect(fake.workers[0].stops).toBe(1)
    expect(pool.stats()).toMatchObject({
      configured: 1,
      workers: 2,
      active: 2,
    })

    fake.workers[1].receive({
      type: "complete",
      requestId: runs[1].requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    expect((await streams[1].fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    expect(fake.workers[1].stops).toBe(0)
    releaseTurn(fake.workers[1], runs[1].requestId)
    expect(fake.workers[1].stops).toBe(1)
    expect(pool.stats()).toMatchObject({
      configured: 1,
      workers: 1,
      active: 1,
    })

    fake.workers[2].receive({
      type: "complete",
      requestId: runs[2].requestId,
      turns: 1,
      memoryBeforeDispose: workerMemory(2, 2),
      memory: workerMemory(),
    })
    expect((await streams[2].fullStream[Symbol.asyncIterator]().next()).done).toBe(true)
    releaseTurn(fake.workers[2], runs[2].requestId)
    expect(fake.workers[2].stops).toBe(0)
    await pool.stop()
  })

  test("terminates a worker that crosses its heap watermark", async () => {
    const fake = fakeWorkers()
    const pool = new AgentWorkerPool({ ...options, maxHeapBytes: 64 }, fake.spawn)
    const streamPromise = inScope(() => pool.run(input(new AbortController().signal)))
    fake.workers[0].ready()
    const run = startTurn(fake.workers[0])
    fake.workers[0].receive({ type: "started", requestId: run.requestId })
    const stream = await streamPromise

    fake.workers[0].receive({
      type: "heartbeat",
      requestId: run.requestId,
      turns: 0,
      memory: workerMemory(32, 65),
    })

    await expect(stream.fullStream[Symbol.asyncIterator]().next()).rejects.toThrow("Agent worker exited")
    expect(fake.workers).toHaveLength(1)
    await pool.stop()
  })
})
