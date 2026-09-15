import { expect, test } from "bun:test"
import { ProviderRetryCoordinator, providerRetryKey } from "../../src/provider/retry-coordinator"

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

test("a connection shares cooldown and admits only one recovery probe", async () => {
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
    coordinator.stream("connection", signal(), async () => {
      calls++
      throw transient()
    }),
  ).rejects.toMatchObject({ code: "ETIMEOUT" })
  let disposed = 0
  const next = coordinator.stream("connection", signal(), async () => {
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
  })
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
  const opening = coordinator.stream("connection", signal(), async () => ({
    fullStream: (async function* () {})(),
    usage: Promise.resolve(undefined),
    async dispose() {},
  }))
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
