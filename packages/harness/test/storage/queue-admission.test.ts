import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { MAX_PENDING, StorageQueue } from "../../src/storage/queue"
import { TransactionalStore } from "../../src/storage/transactional-store"

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
