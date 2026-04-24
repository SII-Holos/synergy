import { describe, expect, test } from "bun:test"
import { State } from "../../src/scope/state"

describe("State.create", () => {
  test("caches resolved value across calls", () => {
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
  })

  test("auto-evicts on rejection so next call retries", async () => {
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
  })

  test("does not evict on successful resolution", async () => {
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
  })

  test("reset clears cached state for current scope", async () => {
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
  })

  test("resetAll clears cached state across all scopes", async () => {
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
  })
})
