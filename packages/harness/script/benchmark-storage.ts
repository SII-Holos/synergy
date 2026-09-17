import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TransactionalStore } from "../src/storage/transactional-store"
import { Storage } from "../src/storage/storage"
import { RolloutArtifact } from "../src/session/rollout/artifact"
import { RolloutJournal } from "../src/session/rollout/journal"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-storage-benchmark-"))
const count = 1000
const concurrency = 32
const payload = "x".repeat(1024)
try {
  for (const backend of ["sqlite", ...(process.env.SYNERGY_TEST_POSTGRES_URL ? ["postgres"] : [])] as const) {
    const namespace = `benchmark_${crypto.randomUUID()}`
    const store = await TransactionalStore.open(
      backend === "sqlite"
        ? { backend, namespace, filename: path.join(root, "agent.sqlite") }
        : { backend: "postgres", namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
    )
    try {
      const started = performance.now()
      const latencies: number[] = []
      for (let offset = 0; offset < count; offset += concurrency) {
        await Promise.all(
          Array.from({ length: Math.min(concurrency, count - offset) }, async (_, index) => {
            const id = String(offset + index).padStart(8, "0")
            const start = performance.now()
            await store.transaction(async (tx) => {
              await tx.write(["benchmark", "parts", id], { id, payload })
              await tx.write(["benchmark-index", id], { id })
            })
            latencies.push(performance.now() - start)
          }),
        )
      }
      const elapsed = performance.now() - started
      const readStarted = performance.now()
      const page = await store.query({ kind: "benchmark", limit: 100, descending: true })
      const readMs = performance.now() - readStarted
      if (page.length !== 100 || (await store.verify()).records !== count * 2)
        throw new Error("Benchmark verification failed")
      latencies.sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          backend,
          transactions: count,
          records: count * 2,
          concurrency,
          payloadBytes: 1024,
          elapsedMs: Math.round(elapsed),
          transactionsPerSecond: Math.round((count / elapsed) * 1000),
          queuedP50Ms: +latencies[Math.floor(count * 0.5)].toFixed(2),
          queuedP95Ms: +latencies[Math.floor(count * 0.95)].toFixed(2),
          read100Ms: +readMs.toFixed(2),
          processRssMiB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        }),
      )
      await store.transaction((tx) => tx.removeTree([]))
    } finally {
      await store.close()
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

// Key traversal and journal reads are measured separately from commit throughput: their cost is
// dominated by how the store probes the record table, not by transaction or fsync cost. The
// traversal probe deliberately runs against a namespace with many unrelated live records, which
// is the shape that made a small-subtree read scan the whole record set.
const traversalRecords = Number(process.env.SYNERGY_BENCH_TRAVERSAL_RECORDS ?? 20_000)
const journalEvents = Number(process.env.SYNERGY_BENCH_JOURNAL_EVENTS ?? 5_000)
const traversalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-storage-traversal-"))
try {
  const namespace = `traversal_${crypto.randomUUID()}`
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace,
    filename: path.join(traversalRoot, "agent.sqlite"),
  })
  const release = Storage.install({ store, artifactDirectory: path.join(traversalRoot, "artifacts") })
  try {
    await store.transaction(async (tx) => {
      for (let index = 0; index < traversalRecords; index++)
        await tx.write(["bulk", String(index).padStart(8, "0")], { index })
      await tx.write(["probe", "leaf"], { value: 1 })
    })
    const scanStarted = performance.now()
    const children = await store.scan(["probe"])
    const scanMs = performance.now() - scanStarted
    const listStarted = performance.now()
    const keys = await store.list(["probe"])
    const listMs = performance.now() - listStarted
    if (children.length !== 1 || keys.length !== 1) throw new Error("Traversal benchmark verification failed")

    const owner = { kind: "operation" as const, scopeID: "benchmark", operationID: crypto.randomUUID() }
    const journal = [...RolloutArtifact.root(owner), "journal"]
    await store.transaction(async (tx) => {
      for (let seq = 1; seq <= journalEvents; seq++)
        await tx.write([...journal, "events", String(seq).padStart(12, "0")], {
          version: 1,
          kind: "gap",
          seq,
          time: Date.now(),
        })
      await tx.write([...journal, "head"], { allocated: journalEvents, committed: journalEvents })
    })
    const journalStarted = performance.now()
    const sequence: number[] = []
    for await (const event of RolloutJournal.events(owner, journalEvents)) sequence.push(event.seq)
    const journalReadMs = performance.now() - journalStarted
    if (sequence.length !== journalEvents || sequence[0] !== 1 || sequence.at(-1) !== journalEvents)
      throw new Error("Journal benchmark verification failed")

    console.log(
      JSON.stringify({
        harness: "storage-traversal",
        backend: "sqlite",
        namespaceRecords: traversalRecords + 1,
        probeSubtreeRecords: 1,
        scanMs: +scanMs.toFixed(2),
        listMs: +listMs.toFixed(2),
        journalEvents,
        journalReadMs: +journalReadMs.toFixed(2),
        journalMsPerEvent: +(journalReadMs / journalEvents).toFixed(4),
      }),
    )
  } finally {
    release()
    await store.close()
  }
} finally {
  await fs.rm(traversalRoot, { recursive: true, force: true })
}
