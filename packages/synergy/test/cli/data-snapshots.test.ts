import { expect, test } from "bun:test"
import { executeSnapshots } from "../../src/cli/cmd/data/snapshots"
import { ServerProcessLock } from "../../src/util/server-process-lock"

test("snapshot maintenance defaults to dry-run and rejects apply while a server owns the home", async () => {
  const lock = await ServerProcessLock.acquire()
  try {
    expect((await executeSnapshots({ action: "migrate", scope: "empty-cli-scope" })).ok).toBe(true)
    const busy = await executeSnapshots({ action: "compact", scope: "empty-cli-scope", apply: true })
    expect(busy.ok).toBe(false)
    expect(busy.error?.code).toBe("busy")
    expect((await executeSnapshots({ action: "clean", scope: "empty-cli-scope" })).ok).toBe(true)
    const cleanBusy = await executeSnapshots({ action: "clean", scope: "empty-cli-scope", apply: true })
    expect(cleanBusy.ok).toBe(false)
    expect(cleanBusy.error?.code).toBe("busy")
  } finally {
    await lock.release()
  }
})
