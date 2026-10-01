import { describe, expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { StorageRecovery } from "../../src/storage/recovery"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { storageTestBackends } from "../support/storage-backends"

const Changed = BusEvent.define("test.delivery.changed", z.object({ partition: z.string(), value: z.number() }))

function capture(event: Parameters<StorageEventSinks.Sink["capture"]>[0]) {
  if (event.type !== Changed.type) return
  const payload = event.payload as { properties: { partition: string; value: number } }
  return { partition: payload.properties.partition, payload: payload.properties }
}

for (const backend of storageTestBackends()) {
  describe(`${backend} durable external event sinks`, () => {
    test("transaction-local projection reads the committed owner and rolls back on async failure", async () => {
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () =>
          StorageEventSinks.register({
            id: "owner-projection",
            async capture(event) {
              if (event.type !== Changed.type) return
              expect(Storage.inTransaction()).toBe(true)
              const owner = await Storage.read<{ run: string }>(["test-owner"])
              if (owner.run === "reject") throw new Error("invalid owner")
              return { partition: owner.run, payload: { run: owner.run, value: capture(event)!.payload } }
            },
            async deliver() {},
            async captured(delivery) {
              expect(Storage.inTransaction()).toBe(true)
              await Storage.write(["host-event-receipt", delivery.eventID], { sequence: delivery.sequence })
              if ((delivery.payload as { run: string }).run === "reject-receipt") throw new Error("receipt rejected")
            },
          }),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await expect(
              Storage.transaction(async () => {
                await Storage.write(["test-owner"], { run: "reject" })
                await Bus.publish(Changed, { partition: "source", value: 1 })
              }),
            ).rejects.toThrow("invalid owner")
            expect(await Storage.readMany([["test-owner"]])).toEqual([undefined])
            expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
            await Storage.transaction(async () => {
              await Storage.write(["test-owner"], { run: "run-owned" })
              await Bus.publish(Changed, { partition: "source", value: 2 })
            })
            const records = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })
            expect(records[0]!.value.partition).toBe("run-owned")
            expect(records[0]!.value.payload).toEqual({ run: "run-owned", value: { partition: "source", value: 2 } })
            expect(await Storage.read<{ sequence: number }>(["host-event-receipt", records[0]!.value.eventID])).toEqual(
              { sequence: 1 },
            )
            await expect(
              Storage.transaction(async () => {
                await Storage.write(["test-owner"], { run: "reject-receipt" })
                await Bus.publish(Changed, { partition: "source", value: 3 })
              }),
            ).rejects.toThrow("receipt rejected")
            expect(await Storage.read<{ run: string }>(["test-owner"])).toEqual({ run: "run-owned" })
            expect(await Storage.query({ kind: "host-event-receipt" })).toHaveLength(1)
            expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(1)
          },
        }),
      )
    })

    test("delivery records and partition sequences commit with Bus facts and roll back together", async () => {
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () => StorageEventSinks.register({ id: "bridge", capture, deliver: async () => {} }),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await expect(
              Storage.transaction(async () => {
                await Storage.write(["example-fact"], 1)
                await Bus.publish(Changed, { partition: "run-a", value: 1 })
                throw new Error("rollback")
              }),
            ).rejects.toThrow("rollback")
            expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
            expect(await Storage.readMany([["example-fact"], ["event_delivery_meta", "bridge", "run-a"]])).toEqual([
              undefined,
              undefined,
            ])
            await Storage.transaction(async () => {
              await Storage.write(["example-fact"], 2)
              await Promise.all([
                Bus.publish(Changed, { partition: "run-a", value: 2 }),
                Bus.publish(Changed, { partition: "run-a", value: 3 }),
              ])
            })
            const records = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })
            expect(records.map(({ value }) => value.sequence)).toEqual([1, 2])
            expect(records.map(({ value }) => value.payload)).toEqual([
              { partition: "run-a", value: 2 },
              { partition: "run-a", value: 3 },
            ])
            expect(await Storage.current().store.pendingEvents()).toEqual([])
            expect(await StorageEventSinks.flush({ limit: 1 })).toEqual({ delivered: 1 })
            expect((await Storage.query({ kind: "event_delivery" })).length).toBe(1)
            await expect(Storage.transaction(async () => StorageEventSinks.flush())).rejects.toThrow(
              "outside a transaction",
            )
          },
        }),
      )
    })

    test("capture failures abort facts and concurrent pumps preserve partition order", async () => {
      const delivered: number[] = []
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () =>
          StorageEventSinks.register({
            id: "bridge",
            capture(event) {
              const selected = capture(event)
              if (selected && (selected.payload as { value: number }).value === -1) throw new Error("projection failed")
              return selected
            },
            async deliver(delivery) {
              delivered.push(delivery.sequence)
              await Bun.sleep(10)
            },
          }),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await expect(
              Storage.transaction(async () => {
                await Storage.write(["example-fact"], -1)
                await Bus.publish(Changed, { partition: "run-a", value: -1 })
              }),
            ).rejects.toThrow("projection failed")
            expect(await Storage.readMany([["example-fact"]])).toEqual([undefined])
            await Storage.transaction(async () => {
              await Bus.publish(Changed, { partition: "run-a", value: 1 })
              await Bus.publish(Changed, { partition: "run-a", value: 2 })
            })
            await Promise.all([StorageEventSinks.flush({ limit: 1 }), StorageEventSinks.flush({ limit: 1 })])
            expect(delivered).toEqual([1, 2])
            expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
          },
        }),
      )
    })

    test("lost external acknowledgments replay stable identities after store and Runtime restart", async () => {
      await using directory = await tmpdir()
      const namespace = crypto.randomUUID()
      const options =
        backend === "postgres"
          ? ({ backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! } as const)
          : ({ backend, namespace, filename: path.join(directory.path, "authority.sqlite") } as const)
      const attempts: StorageEventSinks.Delivery[] = []
      let store = await TransactionalStore.open(options)
      const handle = () => ({ store, artifactDirectory: directory.path })
      try {
        await using first = await testRuntime({
          register: () =>
            StorageEventSinks.register({
              id: "bridge",
              capture,
              async deliver(delivery) {
                expect(Storage.inTransaction()).toBe(false)
                attempts.push(delivery)
                throw new Error("external acknowledgment lost")
              },
            }),
        })
        await first.run(() =>
          Storage.provide(handle(), async () => {
            await Storage.transaction(async () => {
              await Storage.write(["example-fact"], "committed")
              await Storage.enqueue(
                {
                  id: "stable-event",
                  scopeID: "scope-a",
                  type: Changed.type,
                  payload: { properties: { partition: "run-a", value: 1 } },
                },
                async () => {
                  throw new Error("local subscriber unavailable")
                },
              )
            })
            await expect(StorageEventSinks.flush()).rejects.toThrow("external acknowledgment lost")
            expect(await StorageRecovery.reconcileNotifications()).toBe(1)
            expect((await Storage.query({ kind: "event_delivery" })).length).toBe(1)
          }),
        )
        await first.close()
        await store.close()
        store = await TransactionalStore.open({ ...options, recover: true, mustExist: true })
        await using second = await testRuntime({
          register: () =>
            StorageEventSinks.register({
              id: "bridge",
              capture,
              async deliver(delivery) {
                attempts.push(delivery)
              },
            }),
        })
        await second.run(() =>
          Storage.provide(handle(), async () => {
            expect(await Storage.read<string>(["example-fact"])).toBe("committed")
            expect(await StorageEventSinks.flush()).toEqual({ delivered: 1 })
            expect(attempts.length).toBe(2)
            expect(attempts[1]).toEqual(attempts[0])
            expect(attempts[1]).toMatchObject({
              eventID: "stable-event",
              sinkID: "bridge",
              partition: "run-a",
              sequence: 1,
            })
            expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
            await Storage.transaction(async () =>
              Storage.enqueue(
                {
                  id: "next-event",
                  scopeID: "scope-a",
                  type: Changed.type,
                  payload: { properties: { partition: "run-a", value: 2 } },
                },
                async () => {},
              ),
            )
            await StorageEventSinks.flush()
            expect(attempts[2]?.sequence).toBe(2)
          }),
        )
      } finally {
        await store.close()
      }
    })

    test("composition is sealed and absent consumers retain pending records", async () => {
      await using directory = await tmpdir()
      const namespace = crypto.randomUUID()
      const store = await TransactionalStore.open(
        backend === "postgres"
          ? { backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! }
          : { backend, namespace, filename: path.join(directory.path, "authority.sqlite") },
      )
      const handle = { store, artifactDirectory: directory.path }
      try {
        await using producer = await testRuntime({
          register: () => StorageEventSinks.register({ id: "bridge", capture, deliver: async () => {} }),
        })
        await producer.run(() =>
          Storage.provide(handle, () =>
            Storage.transaction(async () => {
              await Storage.enqueue(
                {
                  id: "orphan-event",
                  scopeID: "scope-a",
                  type: Changed.type,
                  payload: { properties: { partition: "run-a", value: 1 } },
                },
                async () => {},
              )
            }),
          ),
        )
        await using consumer = await testRuntime()
        await consumer.run(() =>
          Storage.provide(handle, async () => {
            expect(() => StorageEventSinks.register({ id: "bridge", capture, deliver: async () => {} })).toThrow(
              "before opening the Runtime",
            )
            await expect(StorageEventSinks.flush()).rejects.toThrow("not registered")
            expect((await Storage.query({ kind: "event_delivery" })).length).toBe(1)
          }),
        )
      } finally {
        await store.close()
      }
    })
  })
}
