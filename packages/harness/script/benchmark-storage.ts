import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TransactionalStore } from "../src/storage/transactional-store"

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

// Key traversal is measured separately from commit throughput: its cost is dominated by how the
// store probes the record table, not by transaction or fsync cost. The probe deliberately runs
// against a namespace holding many unrelated live records, which is the shape that exposes a
// namespace-wide liveness scan.
const traversalRecords = Number(process.env.SYNERGY_BENCH_TRAVERSAL_RECORDS ?? 20_000)
const traversalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-storage-traversal-"))
try {
  const namespace = `traversal_${crypto.randomUUID()}`
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace,
    filename: path.join(traversalRoot, "agent.sqlite"),
  })
  try {
    await store.transaction(async (tx) => {
      for (let index = 0; index < traversalRecords; index++)
        await tx.write(["bulk", String(index).padStart(8, "0")], { index })
      await tx.write(["probe", "deep", "leaf"], { value: 1 })
    })
    const scanStarted = performance.now()
    const children = await store.scan(["probe"])
    const scanMs = performance.now() - scanStarted
    const listStarted = performance.now()
    const keys = await store.list(["probe"])
    const listMs = performance.now() - listStarted
    if (children.length !== 1 || keys.length !== 1) throw new Error("Traversal benchmark verification failed")
    const missingDelete: number[] = []
    for (let attempt = 0; attempt < 100; attempt++) {
      const started = performance.now()
      await store.removeTree(["missing", "order-markers"])
      missingDelete.push(performance.now() - started)
    }
    missingDelete.sort((a, b) => a - b)
    const batchKeys = Array.from({ length: 128 }, (_, index) => ["inbox", "owner", String(index)])
    await store.transaction((tx) => tx.writeMany(batchKeys.map((key) => ({ key, value: { queued: true } }))))
    const deleteStarted = performance.now()
    await store.transaction((tx) => tx.removeMany(batchKeys))
    const batchDeleteMs = performance.now() - deleteStarted
    if ((await store.list(["inbox"])).length || (await store.list(["probe"])).length !== 1)
      throw new Error("Cleanup benchmark verification failed")
    console.log(
      JSON.stringify({
        harness: "storage-traversal",
        backend: "sqlite",
        namespaceRecords: traversalRecords + 1,
        probeSubtreeRecords: 1,
        scanMs: +scanMs.toFixed(2),
        listMs: +listMs.toFixed(2),
        missingDeleteP95Ms: +missingDelete[94].toFixed(2),
        delete128Ms: +batchDeleteMs.toFixed(2),
      }),
    )
  } finally {
    await store.close()
  }
} finally {
  await fs.rm(traversalRoot, { recursive: true, force: true })
}

// Owner enumeration is measured against a rollout-shaped namespace because that
// is what retention scans, and its cost is the difference between a bounded
// seek and a full group. `storage_records_owner` carries the owner columns, so
// the statement resolves `MAX(updated)` per owner without touching `key_text`;
// reintroducing that column would turn this back into a per-row table walk while
// still looking correct.
const ownerRecords = Number(process.env.SYNERGY_BENCH_OWNER_RECORDS ?? 200_000)
const ownerCount = Number(process.env.SYNERGY_BENCH_OWNER_COUNT ?? 50)
const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-storage-owners-"))
try {
  const namespace = `owners_${crypto.randomUUID()}`
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace,
    filename: path.join(ownerRoot, "agent.sqlite"),
  })
  try {
    // Written through the real store so the index the enumeration depends on is
    // maintained by production code rather than by fixture SQL.
    for (let offset = 0; offset < ownerRecords; offset += 500) {
      const batch = Math.min(500, ownerRecords - offset)
      await store.transaction(async (tx) => {
        for (let index = offset; index < offset + batch; index++) {
          const owner = index % ownerCount
          await tx.write(["sessions", `scope_${owner}`, `ses_${owner}`, "rollout", "runs", `run_${index}`, "info"], {
            index,
            pad: "x".repeat(64),
          })
        }
      })
    }

    await store.evidenceOwners()
    const started = performance.now()
    const owners = await store.evidenceOwners()
    const enumerationMs = performance.now() - started
    if (owners.length !== ownerCount) throw new Error("Owner enumeration benchmark verification failed")

    const pointStart = performance.now()
    for (let index = 0; index < 200; index++)
      await store.read<{ index: number }>(["sessions", "scope_0", "ses_0", "rollout", "runs", "run_0", "info"])
    const pointReadMs = (performance.now() - pointStart) / 200

    const readStarted = performance.now()
    const page = await store.query({ kind: "rollout", limit: 256, descending: true })
    const pageMs = performance.now() - readStarted
    if (page.length !== 256) throw new Error("Owner page benchmark verification failed")

    console.log(
      JSON.stringify({
        harness: "storage-owners",
        backend: "sqlite",
        rolloutRecords: ownerRecords,
        owners: ownerCount,
        // The number the defect was about: this is one serialized reader lane
        // that the whole process shares.
        enumerationMs: +enumerationMs.toFixed(2),
        pointReadMs: +pointReadMs.toFixed(3),
        page256Ms: +pageMs.toFixed(2),
      }),
    )
  } finally {
    await store.close()
  }
} finally {
  await fs.rm(ownerRoot, { recursive: true, force: true })
}

// A mixed workload measures the coupling the owner-enumeration defect turned on.
// The store serves reads and writes through one serialized lane per direction,
// so read latency and write latency are not independent: a slow statement on
// either lane delays the other. Reporting both percentiles under contention is
// what shows whether a change moved that coupling or only one side of it.
const mixedWorkers = Number(process.env.SYNERGY_BENCH_MIXED_WORKERS ?? 8)
const mixedDurationMs = Number(process.env.SYNERGY_BENCH_MIXED_MS ?? 3_000)
const mixedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-storage-mixed-"))
try {
  const namespace = `mixed_${crypto.randomUUID()}`
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace,
    filename: path.join(mixedRoot, "agent.sqlite"),
  })
  try {
    const seedCount = 64
    for (let index = 0; index < seedCount; index++)
      await store.write(["seed", String(index).padStart(8, "0")], { index })
    const readers: number[] = []
    const writers: number[] = []
    const deadline = performance.now() + mixedDurationMs
    let readIndex = 0
    let writeIndex = 0
    const reader = async () => {
      while (performance.now() < deadline) {
        const started = performance.now()
        await store.read<{ index: number }>(["seed", String(readIndex++ % seedCount).padStart(8, "0")])
        readers.push(performance.now() - started)
      }
    }
    const writer = async () => {
      while (performance.now() < deadline) {
        const started = performance.now()
        await store.write(["mixed", String(writeIndex++).padStart(8, "0")], { at: Date.now() })
        writers.push(performance.now() - started)
      }
    }
    await Promise.all([
      ...Array.from({ length: mixedWorkers }, reader),
      ...Array.from({ length: mixedWorkers }, writer),
    ])
    if (!readers.length || !writers.length) throw new Error("Mixed workload benchmark produced no samples")
    const percentile = (samples: number[], fraction: number) => {
      const sorted = [...samples].sort((left, right) => left - right)
      return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(3)
    }
    console.log(
      JSON.stringify({
        harness: "storage-mixed",
        backend: "sqlite",
        readerWorkers: mixedWorkers,
        writerWorkers: mixedWorkers,
        reads: readers.length,
        writes: writers.length,
        readP50Ms: percentile(readers, 0.5),
        readP95Ms: percentile(readers, 0.95),
        writeP50Ms: percentile(writers, 0.5),
        writeP95Ms: percentile(writers, 0.95),
      }),
    )
  } finally {
    await store.close()
  }
} finally {
  await fs.rm(mixedRoot, { recursive: true, force: true })
}
