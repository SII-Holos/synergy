import { expect, test } from "bun:test"
import { ProviderRetryCoordinator, providerRetryKey } from "../../src/provider/retry-coordinator"
import type { AgentTurnStreamPart } from "../../src/session/agent-turn/worker-pool"

function fixture() {
  let now = 0
  const sleepers = new Set<{ due: number; resolve(): void }>()
  const coordinator = new ProviderRetryCoordinator({
    now: () => now,
    random: () => 0,
    maxWaitMs: 10_000,
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted()
        const wake = { due: now + ms, resolve: finish }
        function finish() {
          sleepers.delete(wake)
          signal.removeEventListener("abort", abort)
          resolve()
        }
        function abort() {
          sleepers.delete(wake)
          reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        sleepers.add(wake)
      })
    },
  })
  return {
    coordinator,
    async advance(ms: number) {
      now += ms
      for (const wake of [...sleepers]) if (wake.due <= now) wake.resolve()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
    pending: () => sleepers.size,
  }
}

const transient = () => Object.assign(new Error("getaddrinfo ETIMEOUT"), { code: "ETIMEOUT" })
const signal = () => new AbortController().signal

async function recoveryStream(
  state: ReturnType<typeof fixture>,
  fullStream: AsyncIterable<AgentTurnStreamPart>,
  options: { signal?: AbortSignal; dispose?: () => Promise<void> } = {},
) {
  const first = await state.coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const opening = state.coordinator.acquire("connection", options.signal ?? signal()).then((lease) =>
    lease.stream(async () => ({
      fullStream,
      usage: Promise.resolve(undefined),
      dispose: options.dispose ?? (async () => {}),
    })),
  )
  await state.advance(1000)
  return opening
}

const progressEvents: AgentTurnStreamPart[] = [
  { type: "text-delta", id: "answer", text: "First" },
  { type: "reasoning-delta", id: "reasoning", text: "Thinking" },
  { type: "tool-input-delta", id: "tool", delta: "{" },
  { type: "tool-call", toolCallId: "tool", toolName: "fixture", input: {} },
]

test.each(progressEvents)("a long response with %j admits another request before completion", async (event) => {
  const state = fixture()
  const source = (async function* () {
    yield event
    yield { type: "text-delta" as const, id: "answer", text: "Last" }
  })()
  const stream = await recoveryStream(state, source)
  const reader = stream.fullStream[Symbol.asyncIterator]()
  let started = false
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  const waiting = state.coordinator.acquire("connection", signal()).then((value) => {
    started = true
    lease = value
  })
  try {
    expect((await reader.next()).value).toEqual(event)
    await state.advance(999)
    expect(started).toBe(false)
    await state.advance(1)
    expect(started).toBe(true)
    await state.advance(5 * 60_000)
    expect((await reader.next()).value).toMatchObject({ text: "Last" })
    expect(state.pending()).toBe(0)
  } finally {
    lease?.release()
    state.coordinator.close()
    await Promise.allSettled([waiting, reader.return?.()])
  }
})

test("lifecycle events and empty deltas cannot release a recovery probe", async () => {
  const state = fixture()
  const events: AgentTurnStreamPart[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "answer" },
    { type: "reasoning-start", id: "reasoning" },
    { type: "tool-input-start", id: "tool", toolName: "fixture" },
    { type: "text-delta", id: "answer", text: "" },
    { type: "reasoning-delta", id: "reasoning", text: "" },
    { type: "tool-input-delta", id: "tool", delta: "" },
    { type: "text-end", id: "answer" },
    { type: "reasoning-end", id: "reasoning" },
    { type: "tool-input-end", id: "tool" },
    { type: "tool-result", toolCallId: "tool" },
  ]
  const stream = await recoveryStream(
    state,
    (async function* () {
      yield* events
    })(),
  )
  const reader = stream.fullStream[Symbol.asyncIterator]()
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  const waiting = state.coordinator.acquire("connection", signal()).then((value) => (lease = value))
  try {
    for (const event of events) {
      expect((await reader.next()).value).toEqual(event)
      await state.advance(200)
      expect(lease).toBeUndefined()
    }
    await reader.next()
    await state.advance(0)
    expect(lease).toBeDefined()
  } finally {
    lease?.release()
    state.coordinator.close()
    await Promise.allSettled([waiting, reader.return?.()])
  }
})

test("additional progress neither postpones admission nor lets immediate retry bypass pacing", async () => {
  const state = fixture()
  const stream = await recoveryStream(
    state,
    (async function* () {
      yield* progressEvents
    })(),
  )
  const reader = stream.fullStream[Symbol.asyncIterator]()
  const controller = new AbortController()
  let retry: (() => boolean) | undefined
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  await reader.next()
  const waiting = state.coordinator
    .acquire("connection", controller.signal, {
      immediate: true,
      onWait: (wait) => (retry = wait?.retry),
    })
    .then((value) => (lease = value))
  try {
    await state.advance(500)
    expect(retry).toBeUndefined()
    expect(lease).toBeUndefined()
    await reader.next()
    await state.advance(499)
    expect(lease).toBeUndefined()
    await state.advance(1)
    expect(lease).toBeDefined()
    controller.abort()
    expect((await reader.next()).value).toEqual(progressEvents[2])
  } finally {
    state.coordinator.close()
    await Promise.allSettled([waiting, reader.return?.()])
  }
})

test.each([false, true])("progress and completion preserve a newer Retry-After, progressed: %s", async (progressed) => {
  const state = fixture()
  const older = await state.coordinator.acquire("connection", signal())
  const stream = await recoveryStream(
    state,
    (async function* () {
      yield* progressEvents
    })(),
  )
  const reader = stream.fullStream[Symbol.asyncIterator]()
  if (progressed) await reader.next()
  const error = Object.assign(transient(), { responseHeaders: { "retry-after": "5" } })
  older.failure(error)
  older.release()
  let retry: (() => boolean) | undefined
  let reported: unknown
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  const waiting = state.coordinator
    .acquire("connection", signal(), {
      immediate: true,
      onWait: (wait) => {
        retry = wait?.retry
        reported = wait?.error
      },
    })
    .then((value) => (lease = value))
  try {
    while (!(await reader.next()).done) {}
    await state.advance(1000)
    expect(lease).toBeUndefined()
    expect(retry).toBeUndefined()
    expect(reported).toBe(error)
    await state.advance(3999)
    expect(lease).toBeUndefined()
    await state.advance(1)
    expect(lease).toBeDefined()
  } finally {
    lease?.release()
    state.coordinator.close()
    await Promise.allSettled([waiting, reader.return?.()])
  }
})

test("a thrown body error restores cooldown before stream disposal settles", async () => {
  const state = fixture()
  const disposed = Promise.withResolvers<void>()
  const error = transient()
  const stream = await recoveryStream(
    state,
    (async function* () {
      yield progressEvents[0]!
      throw error
    })(),
    { dispose: () => disposed.promise },
  )
  const reader = stream.fullStream[Symbol.asyncIterator]()
  await reader.next()
  const ending = reader.next().catch((failure: unknown) => failure)
  await state.advance(0)
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  const waiting = state.coordinator.acquire("connection", signal()).then((value) => (lease = value))
  try {
    await state.advance(1999)
    expect(lease).toBeUndefined()
    await state.advance(1)
    expect(lease).toBeDefined()
    disposed.resolve()
    expect(await ending).toBe(error)
  } finally {
    disposed.resolve()
    lease?.release()
    state.coordinator.close()
    await Promise.allSettled([waiting, ending])
  }
})

test.each(["signal", "event", "dispose"] as const)(
  "%s cancellation releases a probe before slow cleanup",
  async (mode) => {
    const state = fixture()
    const controller = new AbortController()
    const disposed = Promise.withResolvers<void>()
    const stream = await recoveryStream(
      state,
      (async function* () {
        yield { type: "abort" as const }
      })(),
      { signal: controller.signal, dispose: () => disposed.promise },
    )
    const reader = stream.fullStream[Symbol.asyncIterator]()
    let cleanup: Promise<unknown> | undefined
    let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
    const waiting = state.coordinator.acquire("connection", signal()).then((value) => (lease = value))
    try {
      if (mode === "signal") controller.abort()
      if (mode === "event") await reader.next()
      if (mode === "dispose") cleanup = stream.dispose()
      await state.advance(0)
      expect(lease).toBeDefined()
      expect(state.pending()).toBe(0)
    } finally {
      disposed.resolve()
      lease?.release()
      state.coordinator.close()
      await Promise.allSettled([waiting, cleanup, stream.dispose(), reader.return?.()])
    }
  },
)

test.each(["cancel", "throw"] as const)("%s during the admission callback does not strand the probe", async (mode) => {
  const state = fixture()
  const first = await state.coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const controller = new AbortController()
  const reason = new Error("cancelled on admission")
  const rejected = state.coordinator
    .acquire("connection", controller.signal, {
      immediate: true,
      onWait: (wait) => {
        if (wait) return
        if (mode === "throw") throw reason
        controller.abort(reason)
      },
    })
    .catch((error: unknown) => error)
  expect(await rejected).toBe(reason)
  const next = await state.coordinator.acquire("connection", signal())
  next.release()
  state.coordinator.close()
  expect(state.pending()).toBe(0)
})

test("recovery progress admits one request at a time and remains sensitive to body failures", async () => {
  const state = fixture()
  const disposed = Promise.withResolvers<void>()
  const stream = await recoveryStream(
    state,
    (async function* () {
      yield { type: "reasoning-delta" as const, id: "reasoning", text: "Working" }
      yield { type: "error" as const, error: transient() }
    })(),
    { dispose: () => disposed.promise },
  )
  const reader = stream.fullStream[Symbol.asyncIterator]()
  const leases: Array<Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>>> = []
  const waiting = Array.from({ length: 2 }, () =>
    state.coordinator.acquire("connection", signal()).then((lease) => leases.push(lease)),
  )
  try {
    await reader.next()
    await state.advance(1000)
    expect(leases).toHaveLength(1)
    expect((await reader.next()).value).toMatchObject({ type: "error" })
    leases[0]!.release()
    await state.advance(1999)
    expect(leases).toHaveLength(1)
    await state.advance(1)
    expect(leases).toHaveLength(2)
  } finally {
    disposed.resolve()
    for (const lease of leases) lease.release()
    state.coordinator.close()
    await Promise.allSettled([...waiting, reader.return?.()])
  }
})

test.each([false, true])("completed probes release admission before disposal, cleanup failure: %s", async (fail) => {
  const state = fixture()
  const disposing = Promise.withResolvers<void>()
  const disposed = Promise.withResolvers<void>()
  const error = new Error("fixture disposal failed")
  const stream = await recoveryStream(state, (async function* () {})(), {
    dispose: async () => {
      disposing.resolve()
      await disposed.promise
      if (fail) throw error
    },
  })
  const consuming = Array.fromAsync(stream.fullStream).catch((failure: unknown) => failure)
  await disposing.promise
  let lease: Awaited<ReturnType<ProviderRetryCoordinator["acquire"]>> | undefined
  const waiting = state.coordinator.acquire("connection", signal()).then((value) => (lease = value))
  try {
    await state.advance(0)
    expect(lease).toBeDefined()
    disposed.resolve()
    expect(await consuming).toEqual(fail ? error : [])
  } finally {
    disposed.resolve()
    state.coordinator.close()
    lease?.release()
    await Promise.allSettled([waiting, consuming])
  }
})

test("a shared cooldown exposes one immediate wake and removes it while the probe runs", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  let retry: (() => boolean) | undefined
  const next = coordinator.acquire("connection", signal(), {
    onWait: (state) => {
      retry = state?.retry
    },
  })
  expect(retry?.()).toBe(true)
  expect(retry?.()).toBe(false)
  await advance(0)
  const probe = await next
  expect(retry).toBeUndefined()
  probe.success()
  probe.release()
})

test("immediate recovery bypasses only local cooldown and still admits one probe", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const probe = await coordinator.acquire("connection", signal(), { immediate: true })
  const waits: Array<{ next?: number; retry?: () => boolean; error: unknown } | undefined> = []
  const other = coordinator.acquire("connection", signal(), { onWait: (state) => waits.push(state) })
  await advance(0)
  expect(waits.at(-1)).toMatchObject({ error: { code: "ETIMEOUT" } })
  expect(waits.at(-1)?.next).toBeUndefined()
  expect(waits.at(-1)?.retry).toBeUndefined()
  probe.success()
  probe.release()
  ;(await other).release()
  expect(waits.at(-1)).toBeUndefined()
})

test("immediate recovery honors server cooldown", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(Object.assign(transient(), { responseHeaders: { "retry-after": "2" } }))
  first.release()
  let started = false
  const waiting = coordinator.acquire("connection", signal(), { immediate: true }).then((lease) => {
    started = true
    return lease
  })
  await advance(1999)
  expect(started).toBe(false)
  await advance(1)
  ;(await waiting).release()
})

test("a connection shares cooldown and admits only one probe without progress", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  let started = 0
  const one = coordinator.acquire("connection", signal()).then((lease) => {
    started++
    return lease
  })
  const two = coordinator.acquire("connection", signal()).then((lease) => {
    started++
    return lease
  })
  await advance(999)
  expect(started).toBe(0)
  await advance(1)
  expect(started).toBe(1)
  const probe = await one
  probe.success()
  probe.release()
  const next = await two
  expect(started).toBe(2)
  next.release()
})

test("an older successful request cannot erase a newer failure", async () => {
  const { coordinator, advance } = fixture()
  const older = await coordinator.acquire("connection", signal())
  const failing = await coordinator.acquire("connection", signal())
  failing.failure(transient())
  failing.release()
  older.success()
  older.release()
  let started = false
  const next = coordinator.acquire("connection", signal()).then((lease) => {
    started = true
    return lease
  })
  await advance(999)
  expect(started).toBe(false)
  await advance(1)
  ;(await next).release()
})

test("a failed probe extends cooldown for every waiting call", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const probePromise = coordinator.acquire("connection", signal())
  await advance(1000)
  const probe = await probePromise
  let started = false
  const next = coordinator.acquire("connection", signal()).then((lease) => {
    started = true
    return lease
  })
  probe.failure(transient())
  probe.release()
  await advance(1999)
  expect(started).toBe(false)
  await advance(1)
  ;(await next).release()
})

test("server hints apply to other sessions and different connections stay independent", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(Object.assign(new Error("busy"), { statusCode: 429, responseHeaders: { "Retry-After": "3" } }))
  first.release()
  const independent = await coordinator.acquire("another", signal())
  independent.release()
  let started = false
  const next = coordinator.acquire("connection", signal()).then((lease) => {
    started = true
    return lease
  })
  await advance(2999)
  expect(started).toBe(false)
  await advance(1)
  ;(await next).release()
})

test("cancelled waiters release listeners and do not reserve recovery probes", async () => {
  const { coordinator, advance, pending } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const controller = new AbortController()
  const cancelled = coordinator.acquire("connection", controller.signal)
  const reason = new Error("user cancelled")
  controller.abort(reason)
  await expect(cancelled).rejects.toBe(reason)
  expect(pending()).toBe(0)
  const next = coordinator.acquire("connection", signal())
  await advance(1000)
  ;(await next).release()
})

test("a recovery wait has a total bound even when another probe stalls", async () => {
  const { coordinator, advance, pending } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const probePromise = coordinator.acquire("connection", signal())
  await advance(1000)
  const probe = await probePromise
  const waiting = coordinator.acquire("connection", signal())
  const checked = waiting.catch((error: unknown) => error)
  await advance(10_000)
  expect(await checked).toMatchObject({ name: "ProviderRecoveryTimeoutError" })
  probe.release()
  expect(pending()).toBe(0)
})

test("permanent and cancelled errors never cool a connection", async () => {
  const { coordinator, pending } = fixture()
  for (const error of [
    Object.assign(new Error("auth"), { statusCode: 401 }),
    new DOMException("cancelled", "AbortError"),
  ]) {
    const first = await coordinator.acquire("connection", signal())
    first.failure(error)
    first.release()
    const next = await coordinator.acquire("connection", signal())
    next.release()
  }
  expect(pending()).toBe(0)
})

test("connection keys isolate endpoints and credentials without exposing their values", () => {
  const model = { providerID: "test", api: { url: "https://example.test/v1" }, options: {} }
  const key = providerRetryKey(model, { key: "secret-one", options: {} })
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(key).toBe(providerRetryKey({ ...model, id: "another-model" }, { key: "secret-one", options: {} }))
  expect(key).not.toBe(providerRetryKey(model, { key: "secret-two", options: {} }))
  expect(key).not.toBe(providerRetryKey(model, { key: "secret-one", options: { baseURL: "https://another.test/v1" } }))
})

test("stream coordination observes startup and body failures without adding attempts", async () => {
  const { coordinator, advance } = fixture()
  let calls = 0
  await expect(
    (await coordinator.acquire("connection", signal())).stream(async () => {
      calls++
      throw transient()
    }),
  ).rejects.toMatchObject({ code: "ETIMEOUT" })
  let disposed = 0
  const next = coordinator.acquire("connection", signal()).then((lease) =>
    lease.stream(async () => {
      calls++
      return {
        fullStream: (async function* () {
          yield { type: "error" as const, error: transient() }
        })(),
        usage: Promise.resolve(undefined),
        async dispose() {
          disposed++
        },
      }
    }),
  )
  await advance(1000)
  const stream = await next
  for await (const _ of stream.fullStream) {
  }
  await stream.dispose()
  expect(disposed).toBe(1)
  expect(calls).toBe(2)
  let started = false
  const waiting = coordinator.acquire("connection", signal()).then((lease) => {
    started = true
    return lease
  })
  await advance(1999)
  expect(started).toBe(false)
  await advance(1)
  ;(await waiting).release()
})

test("disposing an unread recovery stream releases its probe for the next waiter", async () => {
  const { coordinator, advance } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const opening = coordinator.acquire("connection", signal()).then((lease) =>
    lease.stream(async () => ({
      fullStream: (async function* () {})(),
      usage: Promise.resolve(undefined),
      async dispose() {},
    })),
  )
  await advance(1000)
  const stream = await opening
  const next = coordinator.acquire("connection", signal())
  await stream.dispose()
  ;(await next).release()
})

test("a probe success cannot erase a failure reported after the probe started", async () => {
  const { coordinator, advance } = fixture()
  const older = await coordinator.acquire("connection", signal())
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const opening = coordinator.acquire("connection", signal())
  await advance(1000)
  const probe = await opening
  older.failure(transient())
  older.release()
  probe.success()
  probe.release()
  let started = false
  const waiting = coordinator.acquire("connection", signal()).then((lease) => {
    started = true
    return lease
  })
  await advance(1999)
  expect(started).toBe(false)
  await advance(1)
  ;(await waiting).release()
})

test("closing admission cancels queued recovery without stranding a waiter", async () => {
  const { coordinator, pending } = fixture()
  const first = await coordinator.acquire("connection", signal())
  first.failure(transient())
  first.release()
  const waiting = coordinator.acquire("connection", signal())
  coordinator.close()
  await expect(waiting).rejects.toThrow("admission is closed")
  expect(pending()).toBe(0)
  await expect(coordinator.acquire("healthy", signal())).rejects.toThrow("admission is closed")
})
