import { expect, test } from "bun:test"
import path from "node:path"
import { FileLockTimeoutError, withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { SnapshotLease } from "../../src/session/snapshot-lease"
import { StoragePath } from "../../src/storage/path"
import { withTimeout } from "../../src/util/timeout"
import { Global } from "../../src/global"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { tmpdir } from "../support/fixture"

async function holdGate(dataRoot: string, scopeID: string) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const holding = withFileLock(
    { directory: SnapshotLease.directory(dataRoot), key: `snapshot-leases:${scopeID}` },
    async () => {
      entered.resolve()
      await release.promise
    },
  )
  await Promise.race([entered.promise, holding])
  return {
    async [Symbol.asyncDispose]() {
      release.resolve()
      await holding
    },
  }
}

test.each([false, true])("preserves lock-timeout cancellation reasons when already aborted: %s", (aborted) =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using gate = await holdGate(tmp.path, "cancelled-scope")
    const controller = new AbortController()
    const reason = new FileLockTimeoutError("outer-operation")
    if (aborted) controller.abort(reason)
    const result = SnapshotLease.acquire("cancelled-scope", false, {
      dataRoot: tmp.path,
      signal: controller.signal,
    }).catch((error: unknown) => error)
    if (!aborted) {
      await Bun.sleep(50)
      controller.abort(reason)
    }
    expect(await result).toBe(reason)
    await using home = await SnapshotLease.acquireHome(tmp.path, { timeoutMs: 1000 })
  }),
)

test.each(["", "contended-scope"])(
  "lease admission waits through transient gate contention within its budget: %s",
  (scopeID) =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const gate = await holdGate(tmp.path, scopeID)
      let ran = false
      const acquiring = SnapshotLease.use(
        "contended-scope",
        false,
        async () => {
          ran = true
        },
        { dataRoot: tmp.path, timeoutMs: 10_000 },
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      try {
        await Bun.sleep(1_250)
        expect(ran).toBe(false)
      } finally {
        await gate[Symbol.asyncDispose]()
      }
      expect(await acquiring).toBeUndefined()
      expect(ran).toBe(true)
    }),
  15_000,
)

test.each(["", "contended-scope"])("metadata gate exhaustion reports snapshot busy: %s", (scopeID) =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using gate = await holdGate(tmp.path, scopeID)
    await expect(
      SnapshotLease.acquire("contended-scope", false, { dataRoot: tmp.path, timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(SnapshotLease.BusyError)
  }),
)

test("Home and Scope admission share one timeout budget", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using scopeGate = await holdGate(tmp.path, "budget-scope")
    const homeGate = await holdGate(tmp.path, "")
    const controller = new AbortController()
    const pending = SnapshotLease.use("budget-scope", false, async () => {}, {
      dataRoot: tmp.path,
      timeoutMs: 2_000,
      signal: controller.signal,
    }).catch((error: unknown) => error)
    try {
      await Bun.sleep(1_250)
      await homeGate[Symbol.asyncDispose]()
      expect(await withTimeout(pending, 1_500)).toBeInstanceOf(SnapshotLease.BusyError)
    } finally {
      controller.abort()
      await homeGate[Symbol.asyncDispose]()
      await pending
    }
    await using home = await SnapshotLease.acquireHome(tmp.path, { timeoutMs: 1000 })
  }))

test("aborting a metadata gate wait preserves cancellation and leaves no lease", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const gate = await holdGate(tmp.path, "contended-scope")
    const controller = new AbortController()
    const reason = new Error("cancel snapshot admission")
    const pending = SnapshotLease.acquire("contended-scope", false, {
      dataRoot: tmp.path,
      signal: controller.signal,
    })
    const result = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Bun.sleep(50)
      controller.abort(reason)
      expect(await result).toBe(reason)
    } finally {
      controller.abort(reason)
      await gate[Symbol.asyncDispose]()
    }
    await using home = await SnapshotLease.acquireHome(tmp.path, { timeoutMs: 1000 })
  }))

test.each(["", "contended-scope"])("lease disposal waits through transient gate contention: %s", (scopeID) =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    const lease = await SnapshotLease.acquire("contended-scope", false, {
      dataRoot: tmp.path,
      timeoutMs: 1000,
      signal: controller.signal,
    })
    const gate = await holdGate(tmp.path, scopeID)
    controller.abort()
    const releasing = lease[Symbol.asyncDispose]().then(
      () => undefined,
      (error: unknown) => error,
    )
    try {
      await Bun.sleep(1_250)
    } finally {
      await gate[Symbol.asyncDispose]()
    }
    expect(await releasing).toBeUndefined()
    await using scope = await SnapshotLease.acquire("contended-scope", true, { dataRoot: tmp.path, timeoutMs: 1000 })
    await scope[Symbol.asyncDispose]()
    await using home = await SnapshotLease.acquireHome(tmp.path, { timeoutMs: 1000 })
  }),
)

test("cancelled exclusive admission removes its barrier through gate contention", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using reader = await SnapshotLease.acquire("cleanup-scope", false, { dataRoot: tmp.path })
    const controller = new AbortController()
    const reason = new Error("cancel exclusive admission")
    const pending = SnapshotLease.use("cleanup-scope", true, async () => {}, {
      dataRoot: tmp.path,
      signal: controller.signal,
    }).catch((error: unknown) => error)
    try {
      await withTimeout(
        (async () => {
          const file = Bun.file(path.join(tmp.path, ...StoragePath.snapshotLeases("cleanup-scope")) + ".json")
          while (!(await file.json()).owners.some((owner: { exclusive: boolean }) => owner.exclusive)) {
            controller.signal.throwIfAborted()
            await Bun.sleep(10)
          }
        })(),
        2_000,
      )
      const gate = await holdGate(tmp.path, "cleanup-scope")
      controller.abort(reason)
      try {
        await Bun.sleep(1_250)
      } finally {
        await gate[Symbol.asyncDispose]()
      }
      expect(await pending).toBe(reason)
      await SnapshotLease.use("cleanup-scope", false, async () => {}, { dataRoot: tmp.path, timeoutMs: 1000 })
    } finally {
      controller.abort(reason)
      await pending
    }
    await reader[Symbol.asyncDispose]()
    await using home = await SnapshotLease.acquireHome(tmp.path, { timeoutMs: 1000 })
  }))

test("malformed lease state remains a storage error rather than snapshot busy", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ...StoragePath.snapshotHomeLeases()) + ".json", "not json")
    await expect(SnapshotLease.acquire("corrupt-scope", false, { dataRoot: tmp.path })).rejects.not.toBeInstanceOf(
      SnapshotLease.BusyError,
    )
  }))

test("a full-home backup excludes writes to a Scope created after it acquired ownership", () =>
  runtime.run(async () => {
    await using backup = await SnapshotLease.acquireHome(Global.Path.data)
    await expect(
      SnapshotLease.use("new-scope-" + crypto.randomUUID(), false, async () => {}, { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(SnapshotLease.BusyError)
  }))

test("maintenance excludes another process and recovers its abandoned lease", () =>
  runtime.run(async () => {
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
    }, { dataRoot: ${JSON.stringify(Global.Path.data)} });
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
  }))

test("exclusive maintenance waits for readers and excludes later readers", () =>
  runtime.run(async () => {
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
  }))

test("aborted exclusive acquisition releases its admission barrier", () =>
  runtime.run(async () => {
    const key = "snapshot-lease-" + crypto.randomUUID()
    const signal = new AbortController()
    await SnapshotLease.use(key, false, async () => {
      const pending = SnapshotLease.use(key, true, async () => {}, { signal: signal.signal })
      setTimeout(() => signal.abort(), 40)
      await expect(pending).rejects.toThrow()
      await SnapshotLease.use(key, false, async () => {})
    })
    await SnapshotLease.use(key, true, async () => {})
  }))

afterRuntimeTests(() => runtime.close())
