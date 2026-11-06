import { afterAll, beforeEach, expect, test } from "bun:test"
import { CortexConcurrency } from "../../src/cortex/concurrency"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
afterAll(() => runtime.close())
beforeEach(() => runtime.run(() => CortexConcurrency.reset()))

test("one root can use the configured global ceiling without an agent-type cap", () =>
  runtime.run(async () => {
    CortexConcurrency.configure(32)
    for (let i = 0; i < 32; i++) await CortexConcurrency.acquire("root-a")
    expect(CortexConcurrency.globalStatus()).toMatchObject({ effective: 32, running: 32, queued: 0, source: "config" })
    for (let i = 0; i < 32; i++) CortexConcurrency.release("root-a")
  }))

test("rotates root owners atomically and preserves FIFO within each root", () =>
  runtime.run(async () => {
    CortexConcurrency.configure(1)
    await CortexConcurrency.acquire("a")
    const order: string[] = []
    const pending = ["a", "a", "b", "c"].map((owner) =>
      CortexConcurrency.acquire(owner).then(() => {
        order.push(owner)
        CortexConcurrency.release(owner)
      }),
    )
    CortexConcurrency.release("a")
    await Promise.all(pending)
    expect(order).toEqual(["b", "c", "a", "a"])
  }))

test("cancellation removes a waiter and resizing wakes demand without oversubscription", () =>
  runtime.run(async () => {
    CortexConcurrency.configure(1)
    await CortexConcurrency.acquire("a")
    const abort = new AbortController()
    const cancelled = CortexConcurrency.acquire("b", abort.signal)
    abort.abort(new Error("cancelled"))
    await expect(cancelled).rejects.toThrow("cancelled")
    const pending = CortexConcurrency.acquire("c")
    CortexConcurrency.configure(2)
    await pending
    expect(CortexConcurrency.globalStatus()).toMatchObject({ running: 2, queued: 0 })
    CortexConcurrency.configure(1)
    expect(CortexConcurrency.globalStatus().running).toBe(2)
    CortexConcurrency.release("a")
    CortexConcurrency.release("c")
    CortexConcurrency.release("c")
    expect(CortexConcurrency.globalStatus().running).toBe(0)
  }))

test("reset rejects queued work rather than orphaning it", () =>
  runtime.run(async () => {
    CortexConcurrency.configure(1)
    await CortexConcurrency.acquire("a")
    const pending = CortexConcurrency.acquire("b")
    CortexConcurrency.reset()
    await expect(pending).rejects.toThrow("reset")
  }))
