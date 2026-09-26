import { describe, expect, test } from "bun:test"
import { State } from "../../src/scope/state"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("State.create", () => {
  test("caches resolved value across calls", () =>
    runtime.run(() => {
      let calls = 0
      const accessor = State.create(
        () => "test-scope",
        () => {
          calls++
          return Promise.resolve({ value: 42 })
        },
      )

      const a = accessor()
      const b = accessor()
      expect(a).toBe(b)
      expect(calls).toBe(1)
    }))

  test("auto-evicts on rejection so next call retries", () =>
    runtime.run(async () => {
      let calls = 0
      let shouldFail = true
      const accessor = State.create(
        () => "test-evict",
        () => {
          calls++
          if (shouldFail) return Promise.reject(new Error("transient"))
          return Promise.resolve({ value: "recovered" })
        },
      )

      const first = accessor()
      expect(calls).toBe(1)
      await expect(first).rejects.toThrow("transient")

      // Allow microtask for the eviction .catch handler to run
      await new Promise((r) => setTimeout(r, 0))

      // Next call should retry init, not return the cached rejection
      shouldFail = false
      const second = accessor()
      expect(calls).toBe(2)
      await expect(second).resolves.toEqual({ value: "recovered" })
    }))

  test("does not evict on successful resolution", () =>
    runtime.run(async () => {
      let calls = 0
      const accessor = State.create(
        () => "test-stable",
        () => {
          calls++
          return Promise.resolve("ok")
        },
      )

      const first = accessor()
      await expect(first).resolves.toBe("ok")

      // After resolution, cache should still hold
      const second = accessor()
      expect(calls).toBe(1)
      expect(second).toBe(first)
    }))

  test("reset clears cached state for current scope", () =>
    runtime.run(async () => {
      let calls = 0
      const accessor = State.create(
        () => "test-reset",
        () => {
          calls++
          return Promise.resolve(calls)
        },
      )

      await accessor()
      expect(calls).toBe(1)

      await accessor.reset()
      await accessor()
      expect(calls).toBe(2)
    }))

  test("resetAll clears cached state across all scopes", () =>
    runtime.run(async () => {
      let currentScope = "scope-a"
      let calls = 0
      const accessor = State.create(
        () => currentScope,
        () => {
          calls++
          return Promise.resolve(calls)
        },
      )

      // Init in scope-a
      await accessor()
      expect(calls).toBe(1)

      // Init in scope-b
      currentScope = "scope-b"
      await accessor()
      expect(calls).toBe(2)

      // resetAll clears both
      await accessor.resetAll()

      currentScope = "scope-a"
      await accessor()
      expect(calls).toBe(3)

      currentScope = "scope-b"
      await accessor()
      expect(calls).toBe(4)
    }))
})

test("disposal restores each entry's creation context and concurrent reset waits once", () =>
  runtime.run(async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks")
    const context = new AsyncLocalStorage<string>()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const disposed: string[] = []
    const accessor = State.create(
      () => context.getStore()!,
      () => context.getStore()!,
      async (value) => {
        expect(context.getStore()).toBe(value)
        disposed.push(value)
        entered.resolve()
        await release.promise
      },
    )
    context.run("bound-a", accessor)
    context.run("bound-b", accessor)
    const first = context.run("bound-a", accessor.reset)
    const second = context.run("bound-a", accessor.reset)
    try {
      await entered.promise
      expect(disposed).toEqual(["bound-a"])
    } finally {
      release.resolve()
      await Promise.all([first, second])
      await accessor.resetAll()
      await State.dispose("bound-a")
      await State.dispose("bound-b")
    }
    expect(disposed).toEqual(["bound-a", "bound-b"])
  }))

afterRuntimeTests(() => runtime.close())

test("failed disposal waits for other resources, reports failures, and releases every scope", () =>
  runtime.run(async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const released: string[] = []
    const bad = State.create(
      () => "failed-cleanup",
      () => 1,
      async () => {
        throw new Error("cannot release lease")
      },
    )
    const slow = State.create(
      () => "failed-cleanup",
      () => 2,
      async () => {
        entered.resolve()
        await gate.promise
        released.push("slow")
      },
    )
    const other = State.create(
      () => "other-cleanup",
      () => 3,
      async () => {
        released.push("other")
      },
    )
    bad()
    slow()
    other()
    let settled = false
    const disposal = State.disposeAll().then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await entered.promise
    await Bun.sleep(5)
    expect(settled).toBe(false)
    gate.resolve()
    const error = await disposal
    expect(error).toBeInstanceOf(AggregateError)
    expect(released.sort()).toEqual(["other", "slow"])
    expect(bad.peek()).toBeUndefined()
    expect(slow.peek()).toBeUndefined()
    expect(other.peek()).toBeUndefined()
    await State.disposeAll()
  }))
