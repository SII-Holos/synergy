import { describe, expect, test } from "bun:test"
import { watchManagedParent } from "../../src/server/managed-parent"

describe("managed server parent lifecycle", () => {
  test("requests shutdown immediately when the desktop parent is already gone", () => {
    let shutdowns = 0
    const stop = watchManagedParent({
      expectedParentPid: "123",
      hasProcess: () => false,
      intervalMs: 1_000,
      onParentExit: () => shutdowns++,
    })

    stop()
    expect(shutdowns).toBe(1)
  })

  test("does not request shutdown while the desktop parent is alive", async () => {
    let shutdowns = 0
    const stop = watchManagedParent({
      expectedParentPid: "123",
      hasProcess: () => true,
      intervalMs: 5,
      onParentExit: () => shutdowns++,
    })

    await Bun.sleep(15)
    stop()
    expect(shutdowns).toBe(0)
  })

  test("does not install a watcher without a valid desktop parent PID", async () => {
    let shutdowns = 0
    const stop = watchManagedParent({
      expectedParentPid: "invalid",
      hasProcess: () => false,
      intervalMs: 5,
      onParentExit: () => shutdowns++,
    })

    await Bun.sleep(15)
    stop()
    expect(shutdowns).toBe(0)
  })
})
