import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MAX_PENDING, StorageQueue, withStorageQueueOptions } from "../../src/storage/queue"
import { AsyncLocalStorage } from "node:async_hooks"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageBusyError, StorageClosedError } from "../../src/storage/errors"

async function fixture() {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "queue-admission-"))
  const filename = path.join(directory, "agent.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: "queue-admission", filename })
  return {
    store,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

describe("storage queue identity", () => {
  test("a nested admission cannot extend its parent deadline or replace cancellation", async () => {
    const queue = new StorageQueue("test.inherited")
    const parent = new AbortController()
    parent.abort(new Error("parent cancelled"))
    await expect(
      withStorageQueueOptions({ signal: parent.signal }, () =>
        withStorageQueueOptions({ signal: new AbortController().signal }, () => queue.run(async () => true)),
      ),
    ).rejects.toThrow("parent cancelled")
    await expect(
      withStorageQueueOptions({ deadline: performance.now() - 1 }, () =>
        withStorageQueueOptions({ deadline: performance.now() + 60_000 }, () => queue.run(async () => true)),
      ),
    ).rejects.toBeInstanceOf(StorageBusyError)
    await queue.close()
  })

  test("dispatch preserves the waiting caller's context", async () => {
    const context = new AsyncLocalStorage<string>()
    const queue = new StorageQueue("test.context")
    const release = Promise.withResolvers<void>()
    const first = context.run("holder", () => queue.run(() => release.promise))
    const second = context.run("waiter", () => queue.run(async () => context.getStore()))
    release.resolve()
    expect(await second).toBe("waiter")
    await first
    await queue.close()
  })

  test("expires a waiter while the holder is still running and never executes it later", async () => {
    const queue = new StorageQueue("test.deadline")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = queue.run(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    let executed = false
    const waiting = queue
      .run(
        async () => {
          executed = true
        },
        { deadline: performance.now() + 10 },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    const rescue = setTimeout(() => release.resolve(), 500)
    try {
      expect(await waiting).toBeInstanceOf(StorageBusyError)
      expect(executed).toBe(false)
    } finally {
      clearTimeout(rescue)
      release.resolve()
      await holder
      await queue.close()
    }
    expect(executed).toBe(false)
  })

  test("cancellation removes only the waiter and keeps FIFO order for survivors", async () => {
    const queue = new StorageQueue("test.cancel")
    const release = Promise.withResolvers<void>()
    const holder = queue.run(() => release.promise)
    const abort = new AbortController()
    const order: string[] = []
    const cancelled = queue
      .run(
        async () => {
          order.push("cancelled")
        },
        { signal: abort.signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    const first = queue.run(async () => {
      order.push("first")
    })
    const second = queue.run(async () => {
      order.push("second")
    })
    abort.abort(new Error("cancel queued input"))
    release.resolve()
    expect(await cancelled).toMatchObject({ message: "cancel queued input" })
    await Promise.all([holder, first, second])
    expect(order).toEqual(["first", "second"])
    await queue.close()
  })

  test("foreground work overtakes queued maintenance without overlapping the holder", async () => {
    const queue = new StorageQueue("test.priority")
    const release = Promise.withResolvers<void>()
    const order: string[] = []
    const holder = queue.run(() => release.promise)
    const background = queue.run(
      async () => {
        order.push("background")
      },
      { priority: "background" },
    )
    const foreground = queue.run(async () => {
      order.push("foreground")
    })
    release.resolve()
    await Promise.all([holder, background, foreground])
    expect(order).toEqual(["foreground", "background"])
    await queue.close()
  })

  test("closing rejects pending work and drains the current holder", async () => {
    const queue = new StorageQueue("test.close")
    const release = Promise.withResolvers<void>()
    const holder = queue.run(() => release.promise)
    let executed = false
    const waiting = queue
      .run(async () => {
        executed = true
      })
      .catch((error: unknown) => error)
    const closing = queue.close()
    release.resolve()
    expect(await waiting).toBeInstanceOf(StorageClosedError)
    await Promise.all([holder, closing])
    expect(executed).toBe(false)
  })

  test("names itself when the depth cap rejects a caller", async () => {
    const queue = new StorageQueue("test.queue")
    const gate = Promise.withResolvers<void>()
    const blockers = Array.from({ length: MAX_PENDING }, () => queue.run(() => gate.promise))
    for (const blocker of blockers) void blocker.catch(() => {})
    await expect(queue.run(async () => undefined)).rejects.toThrow("test.queue")
    gate.resolve()
    await Promise.all(blockers)
  })
})

describe("maintenance admission accounting", () => {
  // Maintenance holds the same serialized writer an ordinary transaction does.
  // Reserving the writer without consuming an admission slot would let it hold
  // every waiting caller past its deadline while the queue still reported
  // itself as free.
  test("waits for the writer instead of bypassing admission", async () => {
    await using tmp = await fixture()
    const { store } = tmp
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const writing = store.transaction(async () => {
      await held
    })
    await Bun.sleep(10)
    let maintained = false
    const maintenance = store.maintain({ operation: "reclaim", maxPages: 1 }).then((result) => {
      maintained = true
      return result
    })
    await Bun.sleep(20)
    expect(maintained).toBe(false)
    release!()
    await writing
    await maintenance
    expect(maintained).toBe(true)
  })

  test("a reclaim pass uses a checkpoint that does not wait for readers", async () => {
    await using tmp = await fixture()
    const { store } = tmp
    // A blocking TRUNCATE checkpoint would hold the worker while any reader was
    // active; the pass must complete with a reader transaction open.
    const reading = store.snapshot(async () => {
      await Bun.sleep(50)
    })
    const result = await store.maintain({ operation: "reclaim", maxPages: 8 })
    await reading
    expect(result.autoVacuum).toBe("incremental")
  })
})

describe("storage queue metrics", () => {
  test("reports wait and depth through the observability metrics surface", async () => {
    const { ObservabilityMetrics } = await import("../../src/observability/metrics")
    const names: string[] = []
    using spy = spyOn(ObservabilityMetrics, "record").mockImplementation((input: { name: string }) => {
      names.push(input.name)
    })
    const queue = new StorageQueue("test.metrics")
    const first = queue.run(async () => {
      await Bun.sleep(5)
    })
    const second = queue.run(async () => undefined)
    await Promise.all([first, second])
    expect(spy).toBeDefined()
    expect(names).toContain("storage.queue.depth")
    expect(names).toContain("storage.queue.wait")
  })

  // The holder is what a stalled queue cannot otherwise name: the wait budget is
  // checked once before the body runs, so a long-holding caller was never
  // measured.
  test("reports how long a caller held the queue", async () => {
    const { ObservabilityMetrics } = await import("../../src/observability/metrics")
    const names: string[] = []
    using spy = spyOn(ObservabilityMetrics, "record").mockImplementation((input: { name: string }) => {
      names.push(input.name)
    })
    const queue = new StorageQueue("test.hold")
    await queue.run(async () => {
      await Bun.sleep(1_050)
    })
    expect(spy).toBeDefined()
    expect(names).toContain("storage.queue.hold")
  })
})
