import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import type { SqlConnection, SqlTransactionOptions } from "../src/storage/sql-contract"

const source = path.resolve(process.env.SYNERGY_BENCH_SOURCE ?? path.join(import.meta.dir, "../../.."))
const load = <T>(file: string): Promise<T> => import(pathToFileURL(path.join(source, file)).href)
const { RuntimeContext } = await load<typeof import("../src/lifecycle/context")>(
  "packages/harness/src/lifecycle/context.ts",
)
const { TransactionalStore, StoreTransaction } = await load<typeof import("../src/storage/transactional-store")>(
  "packages/harness/src/storage/transactional-store.ts",
)
const { SqliteDriver } = await load<typeof import("../src/storage/sqlite-driver")>(
  "packages/harness/src/storage/sqlite-driver.ts",
)
const { Storage } = await load<typeof import("../src/storage/storage")>("packages/harness/src/storage/storage.ts")
const { RolloutLedger } = await load<typeof import("../src/session/rollout/ledger")>(
  "packages/harness/src/session/rollout/ledger.ts",
)
const { RolloutArtifact } = await load<typeof import("../src/session/rollout/artifact")>(
  "packages/harness/src/session/rollout/artifact.ts",
)
const { RolloutJournal } = await load<typeof import("../src/session/rollout/journal")>(
  "packages/harness/src/session/rollout/journal.ts",
)
const { RolloutTransport } = await load<typeof import("../src/session/rollout/transport")>(
  "packages/harness/src/session/rollout/transport.ts",
)
const { RolloutTransportRecorder } = await load<typeof import("../src/session/rollout/transport-recorder")>(
  "packages/harness/src/session/rollout/transport-recorder.ts",
)
const { ObservabilityMetrics } = await load<typeof import("../src/observability/metrics")>(
  "packages/harness/src/observability/metrics.ts",
)
const { registerCoreEvents } = await load<typeof import("../src/bus/register")>("packages/harness/src/bus/register.ts")
const { createViewProjection } = await load<typeof import("../../server/src/server/view-projection")>(
  "packages/server/src/server/view-projection.ts",
)
const concurrency = Number(process.env.SYNERGY_BENCH_CONCURRENCY ?? 8)
const chunks = Number(process.env.SYNERGY_BENCH_CHUNKS ?? 1000)
if (![8, 16].includes(concurrency) || !Number.isSafeInteger(chunks) || chunks < 10)
  throw new Error("Use 8/16 streams and at least 10 chunks")
const temporary = !process.env.SYNERGY_BENCH_FIXTURE_HOME
const home =
  process.env.SYNERGY_BENCH_FIXTURE_HOME ?? (await fs.mkdtemp(path.join(os.tmpdir(), "synergy-rollout-benchmark-")))
if (
  !temporary &&
  (path.resolve(home) === path.resolve(os.homedir()) ||
    !(await Bun.file(path.join(home, ".synergy-performance-fixture")).exists()))
)
  throw new Error("A copied Home requires its explicit performance-fixture marker")
const root = path.join(home, ".synergy")
const runtime = RuntimeContext.create({
  home,
  root,
  env: { ...process.env, SYNERGY_HOME: home, SYNERGY_TEST_HOME: home },
})
let commits = 0,
  logicalWrites = 0,
  blocks = 0,
  frameCount = 0,
  frameBytes = 0,
  peakRss = 0,
  peakWal = 0
const driverTransaction = SqliteDriver.prototype.transaction
SqliteDriver.prototype.transaction = function <T>(
  body: (connection: SqlConnection) => Promise<T>,
  options?: SqlTransactionOptions,
): Promise<T> {
  if (!options?.readOnly) commits++
  return driverTransaction.call(this, body, options) as Promise<T>
}
const write = StoreTransaction.prototype.write
StoreTransaction.prototype.write = async function (key, value, options) {
  logicalWrites++
  return write.call(this, key, value, options)
}
const writeMany = StoreTransaction.prototype.writeMany
StoreTransaction.prototype.writeMany = async function (entries) {
  logicalWrites += entries.length
  return writeMany.call(this, entries)
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : value
const metrics = new Map<string, number>()
const firstBlocks: number[] = []
const completed: string[] = []
let store: Awaited<ReturnType<typeof TransactionalStore.open>> | undefined
let server: ReturnType<typeof Bun.serve> | undefined
const filename = path.join(root, "data", "storage", "agent.sqlite")
const beforeBytes = (await fs.stat(filename).catch(() => ({ size: 0 }))).size
try {
  await runtime.run(() =>
    ObservabilityMetrics.withForwarder(
      (metric) => {
        if (metric.unit === "count" || metric.unit === "bytes")
          metrics.set(metric.name, (metrics.get(metric.name) ?? 0) + metric.value)
      },
      async () => {
        registerCoreEvents()
        const manifest = temporary
          ? undefined
          : ((await Bun.file(path.join(root, "data", "storage", "manifest.json")).json()) as { namespace: string })
        store = await TransactionalStore.open({
          backend: "sqlite",
          filename,
          namespace: manifest?.namespace ?? "rollout-benchmark",
        })
        runtime.storage = { store, artifactDirectory: path.join(root, "data") }
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: Number(process.env.SYNERGY_BENCH_PORT ?? 0),
          fetch: () => Response.json({ ready: true, commits, blocks }),
        })
        console.error(JSON.stringify({ phase: "ready", port: server.port }))
        async function history() {
          const histories: string[] = [],
            historyStart = performance.now()
          for (const kind of ["rollout", "operations"]) {
            const heads = await Storage.query<{ committed: number }>({ kind, orderEquals: "head", limit: 8 })
            for (const head of heads) {
              if (head.key.length !== 6 || head.key.slice(3).join("/") !== "rollout/journal/head") continue
              const owner =
                kind === "rollout"
                  ? { kind: "session" as const, scopeID: head.key[1], sessionID: head.key[2] }
                  : { kind: "operation" as const, scopeID: head.key[1], operationID: head.key[2] }
              const hash = createHash("sha256")
              for await (const event of RolloutJournal.events(
                owner,
                head.value.committed,
                Math.max(0, head.value.committed - 128),
              ))
                hash.update(JSON.stringify(canonical(event)))
              histories.push(hash.digest("hex"))
            }
          }
          return { elapsedMs: performance.now() - historyStart, digests: histories }
        }
        const coldHistory = await history(),
          warmHistory = await history()
        if (JSON.stringify(coldHistory.digests) !== JSON.stringify(warmHistory.digests))
          throw new Error("History changed between reads")
        const projection = createViewProjection((frame) => {
          frameCount++
          frameBytes += Buffer.byteLength(JSON.stringify(frame))
        })
        const sequences = Array.from({ length: concurrency }, () => 0)
        const started = performance.now()
        const memory = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          void fs.stat(filename + "-wal").then(
            (stat) => {
              peakWal = Math.max(peakWal, stat.size)
            },
            () => {},
          )
        }, 250)
        try {
          const outcomes = await Promise.allSettled(
            Array.from({ length: concurrency }, async (_, stream) => {
              const owner = { kind: "operation" as const, scopeID: "benchmark", operationID: crypto.randomUUID() }
              const call = await RolloutLedger.beginCall({
                owner,
                runID: "run",
                purpose: "benchmark",
                request: {},
                model: { providerID: "fixture", modelID: "fixture", sdk: "fixture", pricing: null },
              })
              const recorder = RolloutTransportRecorder.create(call)
              const archived: Uint8Array[] = []
              let delivered = 0,
                produced = 0
              const start = performance.now()
              const expectedFailure = stream % 8 === 1
              const cancelled = stream % 8 === 0
              const response = await RolloutTransport.provide(
                async (event) => {
                  await recorder.emit(event)
                  if (event.type === "chunk" && event.channel === "response") {
                    if (!archived.length) firstBlocks.push(performance.now() - start)
                    archived.push(event.data)
                    blocks++
                  }
                },
                () =>
                  RolloutTransport.fetch(
                    async () =>
                      new Response(
                        new ReadableStream<Uint8Array>({
                          async pull(controller) {
                            if (produced >= chunks) {
                              if (expectedFailure) controller.error(new Error("fixture upstream failure"))
                              else controller.close()
                              return
                            }
                            await Bun.sleep(5)
                            const data = new TextEncoder().encode(
                              `data: ${JSON.stringify({ choices: [{ delta: { content: `piece-${stream}-${produced++}-` + "text".repeat(16) } }] })}\n\n`,
                            )
                            controller.enqueue(data)
                            for (const type of ["lsp.client.diagnostics", "rollout.updated", "usage.updated"]) {
                              const frame = projection.project({
                                scopeID: `fixture-${stream}`,
                                payload: {
                                  type,
                                  epoch: "fixture",
                                  seq: ++sequences[stream],
                                  properties: { path: "fixture", serverID: "fixture" },
                                },
                              })
                              if (frame) {
                                frameCount++
                                frameBytes += Buffer.byteLength(JSON.stringify(frame))
                              }
                            }
                          },
                        }),
                        { headers: { "content-type": "text/event-stream" } },
                      ),
                    "https://fixture.invalid",
                  ),
              )
              const reader = response.body!.getReader()
              try {
                for (;;) {
                  const next = await reader.read()
                  if (next.done) break
                  delivered += next.value.byteLength
                  if (cancelled && produced >= chunks / 2) {
                    await reader.cancel()
                    break
                  }
                }
                if (expectedFailure) throw new Error("Missing upstream failure")
              } catch (error) {
                if (!expectedFailure || !(error instanceof Error) || error.message !== "fixture upstream failure")
                  throw error
              } finally {
                reader.releaseLock()
              }
              await recorder.finish()
              const attempts = await RolloutLedger.attempts(owner, "run", call.id)
              const retained = Buffer.concat(await Array.fromAsync(RolloutArtifact.read(owner, attempts[0].response!)))
              if (!retained.equals(Buffer.concat(archived)) || retained.byteLength < delivered)
                throw new Error("Retained response differs from admitted bytes")
              completed.push(attempts[0].status)
              await RolloutLedger.finishCall(owner, "run", call.id, {
                status: cancelled ? "cancelled" : expectedFailure ? "failed" : "completed",
              })
            }),
          )
          const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
          if (errors.length) throw new AggregateError(errors, "Concurrent rollout validation failed")
          await Bun.sleep(60)
          const [retained] = await Storage.snapshot((tx) =>
            tx.raw.query<{ records: number; bytes: number }>(
              "SELECT COUNT(*) AS records, SUM(length(body)) AS bytes FROM storage_records WHERE namespace = ? AND kind = 'operations' AND scope_id = 'benchmark' AND body IS NOT NULL",
              [store!.options.namespace],
            ),
          )
          console.log(
            JSON.stringify({
              concurrency,
              chunks,
              elapsedMs: performance.now() - started,
              coldHistory,
              warmHistory,
              retained: { records: Number(retained.records), bytes: Number(retained.bytes) },
              commits,
              logicalWrites,
              blocks,
              frameCount,
              frameBytes,
              peakRss,
              peakWal,
              firstBlockMs: { min: Math.min(...firstBlocks), max: Math.max(...firstBlocks) },
              outcomes: completed.sort(),
              metrics: Object.fromEntries(metrics),
            }),
          )
        } finally {
          clearInterval(memory)
          projection.dispose()
        }
      },
    ),
  )
} finally {
  server?.stop(true)
  await store?.close()
  runtime.run(() => ObservabilityMetrics.stop())
  runtime.dispose()
  console.error(
    JSON.stringify({
      phase: "closed",
      databaseGrowth: (await fs.stat(filename).catch(() => ({ size: beforeBytes }))).size - beforeBytes,
    }),
  )
  if (temporary) await fs.rm(home, { recursive: true, force: true })
}
