import { describe, expect, test } from "bun:test"
import { watchManagedParent } from "../../src/server/managed-parent"

describe("managed server parent lifecycle", () => {
  test("requests shutdown when the desktop parent disappears", async () => {
    let parentPid = 123
    let shutdowns = 0
    const stop = watchManagedParent({
      expectedParentPid: "123",
      getParentPid: () => parentPid,
      intervalMs: 5,
      onParentExit: () => shutdowns++,
    })

    try {
      await Bun.sleep(10)
      expect(shutdowns).toBe(0)

      parentPid = 1
      await waitFor(() => shutdowns === 1)
      await Bun.sleep(10)
      expect(shutdowns).toBe(1)
    } finally {
      stop()
    }
  })

  test("does not install a watcher without a valid desktop parent PID", async () => {
    let shutdowns = 0
    const stop = watchManagedParent({
      expectedParentPid: "invalid",
      getParentPid: () => 1,
      intervalMs: 5,
      onParentExit: () => shutdowns++,
    })

    await Bun.sleep(15)
    stop()
    expect(shutdowns).toBe(0)
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for managed parent shutdown")
    await Bun.sleep(5)
  }
}
