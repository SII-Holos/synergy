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
