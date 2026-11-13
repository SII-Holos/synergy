import { expect, test } from "bun:test"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { z } from "zod"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RuntimeResources } from "@ericsanchezok/synergy-harness/resources/runtime"
import { nativeResources } from "../../src/resources"

const fixture = process.env.SYNERGY_RESOURCE_HISTORY_FIXTURE
const record = z.object({ key: z.string().array(), value: z.unknown() })

test.skipIf(!fixture)(
  "hydrates copied real history under native admission with bounded allocation and cancellation",
  async () => {
    const source = nativeResources()
    const host = await source.sample()
    if (host.pressure !== "normal") throw new Error("Real-data acceptance requires a healthy host")
    await using runtime = await testRuntime({ resources: source })
    await runtime.run(async () => {
      await using directory = await tmpdir({ config: { execution: { agentWorkers: 1, agentWorkerMinIdle: 0 } } })
      const scope = await directory.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const sessions = new Set<string>()
          let imported = 0
          let bytes = 0
          let peakRss = process.memoryUsage.rss()
          let batch: Array<z.infer<typeof record>> = []
          const bounded = () => {
            peakRss = Math.max(peakRss, process.memoryUsage.rss())
            if (peakRss > 1536 * 1024 ** 2) throw new Error("Acceptance RSS budget exceeded")
          }
          const flush = async () => {
            if (!batch.length) return
            await Storage.transaction((tx) => tx.writeMany(batch))
            batch = []
            bounded()
          }
          for await (const line of createInterface({ input: createReadStream(fixture!), crlfDelay: Infinity })) {
            bytes += Buffer.byteLength(line)
            if (bytes > 256 * 1024 ** 2) throw new Error("Acceptance fixture budget exceeded")
            const entry = record.parse(JSON.parse(line))
            if (entry.key[0] !== "sessions") continue
            entry.key[1] = scope.id
            if (entry.key.length === 4 && entry.key[3] === "info") {
              const value = z.record(z.string(), z.unknown()).parse(entry.value)
              entry.value = { ...value, scope, workspaceID: undefined, environmentID: undefined }
              sessions.add(entry.key[2]!)
            }
            batch.push(entry)
            imported++
            if (batch.length >= 128) await flush()
          }
          await flush()
          await Storage.transaction((tx) => Session.rebuildStorageIndexes(Storage.current().store, tx))
          const timings: Array<{ messages: number; parts: number; modelMessages: number; milliseconds: number }> = []
          for (const sessionID of sessions) {
            const signal = AbortSignal.timeout(30_000)
            const started = performance.now()
            const infos = await SessionHistory.modelMessageInfos({ sessionID })
            const history = await RuntimeResources.allocation(
              { owner: sessionID, bytes: 512 * 1024 ** 2, signal },
              () => SessionHistory.modelMessages({ sessionID, signal }),
            )
            expect(history.length).toBe(infos.length)
            const model = await RuntimeResources.allocation({ owner: sessionID, bytes: 128 * 1024 ** 2, signal }, () =>
              MessageV2.toModelMessage(history),
            )
            expect(model.length).toBeGreaterThan(0)
            const page = await SessionHistory.timelinePage({ sessionID, limit: 20 })
            expect(page.items.length).toBeGreaterThan(0)
            timings.push({
              messages: history.length,
              parts: history.reduce((sum, item) => sum + item.parts.length, 0),
              modelMessages: model.length,
              milliseconds: performance.now() - started,
            })
            bounded()
          }
          const abort = new AbortController()
          let entered = false
          const waiting = RuntimeResources.allocation(
            { owner: "acceptance-wait", bytes: host.domains[0]!.capacityBytes! * 2, signal: abort.signal },
            async () => {
              entered = true
            },
          )
          await Bun.sleep(10)
          abort.abort(new Error("acceptance cancellation"))
          await expect(waiting).rejects.toThrow("acceptance cancellation")
          expect(entered).toBe(false)
          expect(RuntimeResources.status()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 })
          expect(sessions.size).toBeGreaterThan(0)
          const report = {
            imported,
            bytes,
            sessions: sessions.size,
            timings,
            peakRss,
            pressure: RuntimeResources.status().snapshot?.pressure,
          }
          if (process.env.SYNERGY_RESOURCE_REPORT)
            await Bun.write(process.env.SYNERGY_RESOURCE_REPORT, JSON.stringify(report, null, 2))
          console.log(JSON.stringify(report))
        },
      })
    })
  },
  120_000,
)
