import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { runtimeHome } from "../support/runtime-home"
import { RuntimeHandle } from "../../src/lifecycle/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { RolloutExecutionMigration } from "../../src/session/rollout/execution-migration"
import { prepareOwnerMigrations } from "../../src/migration"
import { RolloutLedger } from "../../src/session/rollout/ledger"

test.each([0, 1000, 10000])(
  "runtime readiness does not read cold history (%s owners)",
  async (count) => {
    await using fixture = await runtimeHome()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(fixture.host.root, "fixture.sqlite"),
      namespace: "startup",
    })
    const open = () =>
      RuntimeHandle.open({
        host: fixture.host,
        mode: "oneshot",
        composition: { register() {} },
        storage: { kind: "borrowed", handle: { store, artifactDirectory: path.join(fixture.host.root, "data") } },
      })
    try {
      await (await open()).close()
      for (let first = 0; first < count; first += 128) {
        await store.transaction(async (tx) => {
          const rows = []
          for (let index = first; index < Math.min(count, first + 128); index++) {
            const id = `cold_${index}`
            rows.push({ key: ["sessions", "cold", id, "info"], value: { id, title: "Cold history" } })
            rows.push({ key: ["sessions", "cold", id, "messages", "message", "info"], value: { historical: "body" } })
            rows.push({
              key: ["operations", "cold", id, "rollout", "journal", "head"],
              value: { allocated: 1, committed: 1 },
            })
            rows.push({
              key: ["operations", "cold", id, "rollout", "journal", "events", "000000000001"],
              value: { historical: "journal" },
            })
          }
          await tx.writeMany(rows)
        })
      }
      const elapsed: number[] = []
      for (let trial = 0; trial < 3; trial++) {
        await store.transaction(async (tx) => {
          await tx.remove(StoragePath.rolloutRecoveryPending())
          if (trial < 2) {
            const key = StoragePath.metaMigrationLogDomain("session")
            const log = await tx.read<Record<string, number>>(key)
            delete log[RolloutExecutionMigration.migration.id]
            delete log["20261001-rollout-attempt-price-evidence"]
            await tx.write(key, log)
          }
          if (trial === 1)
            await tx.write(["compat_import", "cohorts", "session", RolloutExecutionMigration.migration.id], {
              domain: "session",
              id: RolloutExecutionMigration.migration.id,
              residentComplete: false,
            })
        })
        using scan = spyOn(Storage, "scan")
        using query = spyOn(Storage, "query")
        using read = spyOn(Storage, "read")
        using readMany = spyOn(Storage, "readMany")
        const start = performance.now()
        const runtime = await open()
        elapsed.push(performance.now() - start)
        try {
          const historical = (key: string[]) => ["sessions", "operations"].includes(key[0]!)
          expect(scan.mock.calls.filter(([key]) => historical(key))).toEqual([])
          expect(read.mock.calls.filter(([key]) => historical(key))).toEqual([])
          expect(readMany.mock.calls.flatMap(([keys]) => keys.filter(historical))).toEqual([])
          expect(
            query.mock.calls.filter(
              ([input]) =>
                ["session", "message", "part", "rollout", "operations"].includes(input.kind ?? "") ||
                historical(input.prefix ?? []),
            ),
          ).toEqual([])
          await runtime.run(async () => {
            const owner = { kind: "operation" as const, scopeID: "hot", operationID: `new_${trial}` }
            expect((await RolloutLedger.beginRun(owner, "new")).timingVersion).toBe(1)
            await prepareOwnerMigrations(owner)
            expect(
              await Storage.read([
                "operations",
                "hot",
                owner.operationID,
                "migrations",
                "session",
                RolloutExecutionMigration.migration.id,
              ]),
            ).toMatchObject({ completed: expect.any(Number) })
          })
        } finally {
          await runtime.close()
        }
      }
      console.info(
        JSON.stringify({
          fixture: "cold-history-readiness",
          sessions: count,
          operations: count,
          historyReads: 0,
          readinessMs: elapsed.map((value) => Math.round(value)),
        }),
      )
    } finally {
      await store.close()
    }
  },
  30000,
)
