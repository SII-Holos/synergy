import { describe, expect, test } from "bun:test"
import { Lock } from "../../src/util/lock"

describe("Lock.writeWithSignal", () => {
  test("acquires immediately on an idle key and excludes other writers", async () => {
    const guard = await Lock.writeWithSignal("lock-test-idle", new AbortController().signal)
    expect(guard).toBeDefined()
    expect(await Lock.tryAcquireWrite("lock-test-idle")).toBeUndefined()
    guard![Symbol.dispose]()
    const next = await Lock.tryAcquireWrite("lock-test-idle")
    expect(next).toBeDefined()
    next![Symbol.dispose]()
  })

  test("queues behind a held writer and grants after release", async () => {
    const first = await Lock.write("lock-test-queue")
    const second = Lock.writeWithSignal("lock-test-queue", new AbortController().signal)
    expect(await Lock.tryAcquireWrite("lock-test-queue")).toBeUndefined()
    first[Symbol.dispose]()
    const granted = await second
    expect(granted).toBeDefined()
    granted![Symbol.dispose]()
  })

  test("returns undefined when aborted while queued and detaches the waiter", async () => {
    const controller = new AbortController()
    const first = await Lock.write("lock-test-abort-queued")
    const queued = Lock.writeWithSignal("lock-test-abort-queued", controller.signal)
    controller.abort()
    expect(await queued).toBeUndefined()
    // The detached waiter must not fire on release: the next writer can acquire.
    first[Symbol.dispose]()
    const released = Lock.write("lock-test-abort-queued")
    expect(await Promise.race([released.then(() => "acquired"), Bun.sleep(50).then(() => "stuck")])).toBe("acquired")
    const guard = await released
    guard[Symbol.dispose]()
  })

  test("never acquires with an already-aborted signal", async () => {
    const guard = await Lock.writeWithSignal("lock-test-preaborted", AbortSignal.abort(new Error("cancelled")))
    expect(guard).toBeUndefined()
    const next = await Lock.tryAcquireWrite("lock-test-preaborted")
    expect(next).toBeDefined()
    next![Symbol.dispose]()
  })
})
