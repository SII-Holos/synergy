import { afterAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { Storage } from "../../src/storage/storage"
import { StorageDropScopeIndex } from "../../src/storage/drop-scope-index"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type { StorageQueue } from "../../src/storage/queue"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

interface RecordedMetric {
  name: string
  value: number
  labels?: Record<string, unknown>
}

interface DriverInternals {
  worker: { send(message: unknown): void }
  readerQueue: StorageQueue
}

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-read-ipc-"))
const stores: TransactionalStore[] = []

afterAll(() =>
  runtime.run(async () => {
    await Promise.all(stores.map((store) => store.close()))
    await fs.rm(root, { recursive: true, force: true })
  }),
)

async function open(backend: "sqlite" | "postgres" = "sqlite") {
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    backend === "sqlite"
      ? { backend, namespace, filename: path.join(root, `${namespace}.sqlite`) }
      : { backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
  )
  stores.push(store)
  return store
}

function internals(store: TransactionalStore) {
  return (store as unknown as { driver: DriverInternals }).driver
}

/** Records every statement the store sends to the SQLite worker. */
function captureStatements(store: TransactionalStore) {
  const worker = internals(store).worker
  const deliver = worker.send.bind(worker)
  const statements: string[] = []
  worker.send = (message: unknown) => {
    const request = message as { action: string; statement?: string }
    if (request.action === "query" && request.statement) statements.push(request.statement)
    return deliver(message)
  }
  return {
    statements,
    restore: () => {
      worker.send = deliver
    },
  }
}

describe("read-only transaction round trips", () => {
  test("a point read issues one statement and no transaction, while multi-statement reads still open one", () =>
    runtime.run(async () => {
      const store = await open()
      await store.write(["perf", "point"], { value: 1 })
      await store.write(["perf", "second"], { value: 2 })

      const capture = captureStatements(store)
      try {
        capture.statements.length = 0
        expect(await store.read<{ value: number }>(["perf", "point"])).toEqual({ value: 1 })
        expect(capture.statements).toHaveLength(1)
        expect(capture.statements.filter((statement) => statement === "BEGIN" || statement === "COMMIT")).toEqual([])

        // A read-only snapshot issuing two statements must keep its explicit
        // transaction: separate statements would otherwise observe separate
        // snapshots.
        capture.statements.length = 0
        await store.snapshot(async (tx) => {
          await tx.read(["perf", "point"])
          await tx.read(["perf", "second"])
        })
        expect(capture.statements[0]).toBe("BEGIN")
        expect(capture.statements.at(-1)).toBe("COMMIT")

        // readMany issues one statement per 128 keys, so a longer list must keep
        // the transaction as well.
        capture.statements.length = 0
        await store.readMany(Array.from({ length: 129 }, (_, index) => ["missing", String(index)]))
        expect(capture.statements[0]).toBe("BEGIN")
        expect(capture.statements.at(-1)).toBe("COMMIT")

        capture.statements.length = 0
        await store.readMany([["perf", "point"]])
        expect(capture.statements).toHaveLength(1)

        // Writes are unaffected: they still take the writer with BEGIN IMMEDIATE,
        // and the rollback path still runs.
        capture.statements.length = 0
        await store.write(["perf", "third"], { value: 3 })
        expect(capture.statements[0]).toBe("BEGIN IMMEDIATE")
        expect(capture.statements.at(-1)).toBe("COMMIT")

        capture.statements.length = 0
        await expect(
          store.transaction(async (tx) => {
            await tx.write(["perf", "rolled-back"], { value: 4 })
            throw new Error("abort")
          }),
        ).rejects.toThrow("abort")
        expect(capture.statements[0]).toBe("BEGIN IMMEDIATE")
        expect(capture.statements.at(-1)).toBe("ROLLBACK")
      } finally {
        capture.restore()
      }
    }))
})

// The store-level wrappers above are not what production calls: the public
// `Storage` surface is, and it is where the round-trip saving has to be
// observable. A regression there would leave the store tests green while every
// real read paid two extra round trips again.
describe("public storage read round trips", () => {
  test("a point read through the public surface issues one statement and no transaction", () =>
    runtime.run(async () => {
      const store = await open()
      await store.write(["perf", "public-point"], { value: 1 })
      await store.write(["perf", "public-second"], { value: 2 })

      const capture = captureStatements(store)
      try {
        await Storage.provide({ store, artifactDirectory: root }, async () => {
          capture.statements.length = 0
          expect(await Storage.read<{ value: number }>(["perf", "public-point"])).toEqual({ value: 1 })
          expect(capture.statements).toHaveLength(1)
          expect(capture.statements.filter((statement) => statement === "BEGIN" || statement === "COMMIT")).toEqual([])

          // The keyed and prefix shapes go through the same single-statement path.
          capture.statements.length = 0
          expect((await Storage.versioned<{ value: number }>(["perf", "public-point"])).value).toEqual({ value: 1 })
          expect(capture.statements).toHaveLength(1)

          capture.statements.length = 0
          expect(await Storage.list(["perf"])).toContainEqual(["perf", "public-point"])
          expect(capture.statements).toHaveLength(1)

          // A key list longer than one batch still needs its transaction, because
          // separate statements would observe separate snapshots.
          capture.statements.length = 0
          await Storage.readMany(Array.from({ length: 129 }, (_, index) => ["missing", String(index)]))
          expect(capture.statements[0]).toBe("BEGIN")
          expect(capture.statements.at(-1)).toBe("COMMIT")

          capture.statements.length = 0
          await Storage.readMany([["perf", "public-point"]])
          expect(capture.statements).toHaveLength(1)
        })
      } finally {
        capture.restore()
      }
    }))
})

describe("storage operation measurement", () => {
  test("store primitives that query the driver directly are visible to telemetry", () =>
    runtime.run(async () => {
      const store = await open()
      const recorded: RecordedMetric[] = []
      const spy = spyOn(ObservabilityMetrics, "record").mockImplementation((input: RecordedMetric) => {
        recorded.push(input)
      })
      const originalRandom = Math.random
      Math.random = () => 0
      try {
        await store.evidenceOwners()
        await store.operationReceipt("missing-receipt")
        await store.pendingEventCount()
        await store.pendingEvents(10)
      } finally {
        Math.random = originalRandom
        spy.mockRestore()
      }

      const operations = new Set(
        recorded
          .filter((row) => row.name === "storage.operation.duration")
          .map((row) => String(row.labels?.["operation"])),
      )
      expect(operations).toEqual(new Set(["evidenceOwners", "operationReceipt", "pendingEventCount", "pendingEvents"]))
      expect(recorded.filter((row) => row.name === "storage.operation.count")).toHaveLength(4)

      // The measurement reuses the existing convention rather than inventing a
      // second family: the bare driver sites emit only the operation metrics.
      const families = new Set(
        recorded.filter((row) => row.name.startsWith("storage.operation.")).map((row) => row.name),
      )
      expect(families).toEqual(new Set(["storage.operation.duration", "storage.operation.count"]))
    }))

  test("operation duration excludes the admission wait the queue reports separately", () =>
    runtime.run(async () => {
      const store = await open()
      const recorded: RecordedMetric[] = []
      const durations: number[] = []
      const spy = spyOn(ObservabilityMetrics, "record").mockImplementation((input: RecordedMetric) => {
        recorded.push(input)
        if (input.name === "storage.operation.duration" && input.labels?.["operation"] === "pendingEventCount")
          durations.push(input.value)
      })
      const originalRandom = Math.random
      Math.random = () => 0
      const HOLD_MS = 250
      try {
        // `pendingEventCount` reads through the serialized reader queue, so holding
        // that queue makes the operation pay a real admission wait.
        const held = internals(store).readerQueue.run(() => new Promise((resolve) => setTimeout(resolve, HOLD_MS)))
        const started = performance.now()
        await store.pendingEventCount()
        const wall = performance.now() - started
        await held

        expect(wall).toBeGreaterThanOrEqual(HOLD_MS)
        expect(durations).toHaveLength(1)
        // Duration must describe the work, not the wait: subtracting it is what
        // keeps this metric from restating `storage.queue.wait`.
        expect(durations[0]).toBeLessThan(HOLD_MS / 2)
        const waits = recorded.filter((row) => row.name === "storage.queue.wait").map((row) => row.value)
        expect(Math.max(...waits)).toBeGreaterThanOrEqual(HOLD_MS / 2)
      } finally {
        Math.random = originalRandom
        spy.mockRestore()
      }
    }))
})

describe("retired scope index", () => {
  test("a fresh store does not create the retired index", () =>
    runtime.run(async () => {
      const store = await open()
      const filename = store.sqliteFilename!
      const check = new Database(filename, { readonly: true })
      try {
        const row = check
          .query<
            { n: number },
            []
          >("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='storage_records_scope'")
          .get()!
        expect(row.n).toBe(0)
      } finally {
        check.close(false)
      }
    }))

  test("the migration drops an existing index and is idempotent", () =>
    runtime.run(async () => {
      const store = await open()
      const filename = store.sqliteFilename!
      const write = new Database(filename)
      try {
        write.run(
          "CREATE INDEX IF NOT EXISTS storage_records_scope ON storage_records(namespace, scope_id, kind, updated, key_id)",
        )
      } finally {
        write.close(false)
      }
      const present = () => {
        const check = new Database(filename, { readonly: true })
        try {
          return check
            .query<
              { n: number },
              []
            >("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='storage_records_scope'")
            .get()!.n
        } finally {
          check.close(false)
        }
      }
      expect(present()).toBe(1)

      await Storage.provide({ store, artifactDirectory: root }, () => StorageDropScopeIndex.run())
      expect(present()).toBe(0)
      // A second run finds nothing to drop and must not fail.
      await Storage.provide({ store, artifactDirectory: root }, () => StorageDropScopeIndex.run())
      expect(present()).toBe(0)
    }))

  test("postgres accepts the same idempotent drop", () =>
    runtime.run(async () => {
      if (!process.env.SYNERGY_TEST_POSTGRES_URL) return
      const store = await open("postgres")
      await expect(store.dropIndexIfExists("storage_records_scope")).resolves.toBeUndefined()
    }))
})

afterRuntimeTests(() => runtime.close())
