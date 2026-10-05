import { describe, expect, test } from "bun:test"
import { RolloutEvents } from "../../src/session/rollout/events"
import { RolloutJournal } from "../../src/session/rollout/journal"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { Storage } from "../../src/storage/storage"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

for (const backend of storageTestBackends()) {
  describe(`${backend} committed rollout evidence`, () => {
    test("host capture commits with evidence and a rejected projection rolls everything back", async () => {
      const delivered: StorageEventSinks.Delivery[] = []
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register() {
          StorageEventSinks.register({
            id: "evidence-host",
            capture(event) {
              if (event.type !== RolloutEvents.RecordCommitted.type) return
              expect(Storage.inTransaction()).toBe(true)
              const { properties } = event.payload as { properties: unknown }
              const evidence = RolloutEvents.RecordCommitted.properties.parse(properties)
              if ((evidence.value as { status: string }).status === "failed") throw new Error("capture unavailable")
              return { partition: evidence.owner.scopeID, payload: evidence }
            },
            async deliver(value) {
              delivered.push(value)
            },
          })
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const owner = { kind: "operation" as const, scopeID: "test", operationID: crypto.randomUUID() }
            const key = [...RolloutArtifact.root(owner), "runs", "run", "info"]
            const running = { version: 1, id: "run", owner, started: 1, status: "running", recording: "partial" }
            expect(await RolloutJournal.write(owner, key, running)).toBe(1)
            const first = (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" }))[0]!.value
            expect(first.payload).toMatchObject({ owner, revision: 1, key: ["runs", "run", "info"], value: running })
            await expect(RolloutJournal.write(owner, key, { ...running, status: "failed" })).rejects.toMatchObject({
              name: "RolloutRecordingError",
            })
            expect(await RolloutJournal.head(owner)).toEqual({ allocated: 1, committed: 1 })
            expect(await Storage.read<typeof running>(key)).toEqual(running)
            expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(1)
            expect(await StorageEventSinks.flush()).toEqual({ delivered: 1 })
            expect(delivered).toEqual([first])
            expect(await RolloutJournal.write(owner, key, { ...running, status: "completed", ended: 2 })).toBe(2)
            await StorageEventSinks.flush()
            expect(delivered.map((value) => value.sequence)).toEqual([1, 2])
            expect(delivered[1]!.payload).toMatchObject({ revision: 2, value: { status: "completed" } })
          },
        }),
      )
    })
  })
}
