import { expect, test } from "bun:test"
import { SnapshotLease } from "../../src/session/snapshot-lease"
import { withTimeout } from "../../src/util/timeout"
import { Global } from "../../src/global"

test("a full-home backup excludes writes to a Scope created after it acquired ownership", async () => {
  await using backup = await SnapshotLease.acquireHome(Global.Path.data)
  await expect(
    SnapshotLease.use("new-scope-" + crypto.randomUUID(), false, async () => {}, { timeoutMs: 50 }),
  ).rejects.toBeInstanceOf(SnapshotLease.BusyError)
})

test("maintenance excludes another process and recovers its abandoned lease", async () => {
  const key = "snapshot-process-" + crypto.randomUUID()
  const module = new URL("../../src/session/snapshot-lease.ts", import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { SnapshotLease } from ${JSON.stringify(module)};
    await SnapshotLease.use(${JSON.stringify(key)}, true, async () => {
      process.stdout.write("ready\\n");
      await Bun.sleep(60000);
    });
  `,
    ],
    { env: process.env, stdout: "pipe", stderr: "pipe" },
  )
  const errors = new Response(child.stderr).text()
  try {
    const reader = child.stdout.getReader()
    try {
      expect(new TextDecoder().decode((await withTimeout(reader.read(), 5000)).value)).toContain("ready")
    } finally {
      reader.releaseLock()
    }
    await expect(SnapshotLease.use(key, false, async () => {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      SnapshotLease.BusyError,
    )
  } finally {
    child.kill()
    await child.exited
    await errors
  }
  await SnapshotLease.use(key, true, async () => {})
})

test("exclusive maintenance waits for readers and excludes later readers", async () => {
  const key = "snapshot-lease-" + crypto.randomUUID()
  const events: string[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = SnapshotLease.use(key, false, async () => {
    events.push("reader")
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const maintenance = SnapshotLease.use(key, true, async () => {
    events.push("maintenance")
  })
  await Bun.sleep(100)
  const later = SnapshotLease.use(key, false, async () => {
    events.push("later")
  })
  await Bun.sleep(50)
  expect(events).toEqual(["reader"])
  release.resolve()
  await Promise.all([first, maintenance, later])
  expect(events).toEqual(["reader", "maintenance", "later"])
})

test("aborted exclusive acquisition releases its admission barrier", async () => {
  const key = "snapshot-lease-" + crypto.randomUUID()
  const signal = new AbortController()
  await SnapshotLease.use(key, false, async () => {
    const pending = SnapshotLease.use(key, true, async () => {}, { signal: signal.signal })
    setTimeout(() => signal.abort(), 40)
    await expect(pending).rejects.toThrow()
    await SnapshotLease.use(key, false, async () => {})
  })
  await SnapshotLease.use(key, true, async () => {})
})
