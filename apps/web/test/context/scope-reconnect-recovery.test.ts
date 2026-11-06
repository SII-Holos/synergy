import { describe, expect, test } from "bun:test"
import { createScopeReconnectRecovery } from "../../src/context/scope-reconnect-recovery"

describe("scope reconnect recovery", () => {
  test("publishes a generation only after that scope recovery completes", async () => {
    const published: Array<[string, number]> = []
    const recovery = createScopeReconnectRecovery((scopeKey, generation) => published.push([scopeKey, generation]))
    let finish!: (recovered: boolean) => void
    const request = new Promise<boolean>((resolve) => {
      finish = resolve
    })

    const pending = recovery.run("/workspace/project", 3, () => request)

    expect(recovery.version("/workspace/project")).toBe(0)
    finish(true)
    await pending
    expect(recovery.version("/workspace/project")).toBe(3)
    expect(published).toEqual([["/workspace/project", 3]])
  })

  test("does not publish a generation when scope recovery fails", async () => {
    const published: Array<[string, number]> = []
    const recovery = createScopeReconnectRecovery((scopeKey, generation) => published.push([scopeKey, generation]))

    await expect(recovery.run("home", 4, async () => false)).resolves.toBe(false)

    expect(recovery.version("home")).toBe(0)
    expect(published).toEqual([])
  })

  test("never regresses when an older recovery completes last", async () => {
    const published: number[] = []
    const recovery = createScopeReconnectRecovery((_scopeKey, generation) => published.push(generation))
    let finishOlder!: (recovered: boolean) => void
    const olderRequest = new Promise<boolean>((resolve) => {
      finishOlder = resolve
    })

    const older = recovery.run("/workspace/project", 1, () => olderRequest)
    await recovery.run("/workspace/project", 2, async () => true)
    finishOlder(true)
    await older

    expect(recovery.version("/workspace/project")).toBe(2)
    expect(published).toEqual([2])
  })
  test("does not publish a recovery that finishes after the scope is released", async () => {
    const published: Array<[string, number]> = []
    const recovery = createScopeReconnectRecovery((scopeKey, generation) => published.push([scopeKey, generation]))
    let finish!: (recovered: boolean) => void
    const request = new Promise<boolean>((resolve) => {
      finish = resolve
    })

    const pending = recovery.run("/workspace/project", 5, () => request)
    recovery.release("/workspace/project")
    finish(true)
    await pending

    expect(recovery.version("/workspace/project")).toBe(0)
    expect(published).toEqual([])
  })
})
