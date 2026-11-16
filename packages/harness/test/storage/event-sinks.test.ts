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

    test("acknowledges the accepted prefix atomically when a later delivery fails", async () => {
      const accepted: number[] = []
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () =>
          StorageEventSinks.register({
            id: "bridge",
            capture,
            async deliver(delivery) {
              expect(Storage.inTransaction()).toBe(false)
              expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(3)
              if (delivery.sequence === 3) throw new Error("receiver unavailable")
              accepted.push(delivery.sequence)
            },
          }),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await Storage.transaction(async () => {
              for (const value of [1, 2, 3]) await Bus.publish(Changed, { partition: "run-a", value })
            })
            await expect(StorageEventSinks.flush()).rejects.toThrow("receiver unavailable")
            expect(accepted).toEqual([1, 2])
            expect(
              (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })).map(
                ({ value }) => value.sequence,
              ),
            ).toEqual([3])
          },
        }),
      )
    })

    test("changed delivery revisions roll back the entire accepted batch acknowledgment", async () => {
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () =>
          StorageEventSinks.register({
            id: "bridge",
            capture,
            async deliver(delivery) {
              if (delivery.sequence !== 2) return
              const record = (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })).find(
                ({ value }) => value.sequence === 2,
              )!
              await Storage.write(record.key, { ...record.value, payload: { changed: true } })
            },
          }),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await Storage.transaction(async () => {
              for (const value of [1, 2]) await Bus.publish(Changed, { partition: "run-a", value })
            })
            await expect(StorageEventSinks.flush()).rejects.toThrow("changed while awaiting acknowledgment")
            expect(
              (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })).map(
                ({ value }) => value.sequence,
              ),
            ).toEqual([1, 2])
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

    test("batch sinks retain ordered windows until the original bounded receiver completes", async () => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const batches: StorageEventSinks.Delivery[][] = []
      const sink = {
        id: "batch-receiver",
        capture,
        async deliver() {
          throw new Error("Native receiver requires its bounded batch contract")
        },
        async deliverBatch(deliveries: readonly Readonly<StorageEventSinks.Delivery>[]) {
          expect(Storage.inTransaction()).toBe(false)
          batches.push(structuredClone([...deliveries]))
          if (batches.length === 1) {
            entered.resolve()
            await release.promise
          }
        },
      }
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () => StorageEventSinks.register(sink),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await Storage.transaction(async () => {
              for (let value = 1; value <= 130; value++) await Bus.publish(Changed, { partition: "run-a", value })
              for (let value = 1; value <= 2; value++) await Bus.publish(Changed, { partition: "run-b", value })
            })
            const original = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery", limit: 1024 })
            const pumping = StorageEventSinks.flush({ limit: 1024 })
            void pumping.catch(() => {})
            try {
              const held = await Promise.race([
                entered.promise.then(() => true),
                pumping.then(
                  () => false,
                  () => false,
                ),
              ])
              if (!held) await pumping
              expect(held).toBe(true)
              expect(await Storage.query({ kind: "event_delivery", limit: 1024 })).toHaveLength(132)
              release.resolve()
              expect(await pumping).toEqual({ delivered: 132 })
              expect(batches.flat().map((value) => value.eventID)).toEqual(original.map((row) => row.value.eventID))
              expect(batches.every((values) => values.length <= 128)).toBe(true)
              expect(batches.some((values) => values.length === 128)).toBe(true)
              expect(
                batches.every((values) =>
                  values.every(
                    (value) => value.sinkID === values[0]!.sinkID && value.partition === values[0]!.partition,
                  ),
                ),
              ).toBe(true)
              expect(
                batches
                  .flat()
                  .filter((value) => value.partition === "run-a")
                  .map((value) => value.sequence),
              ).toEqual(Array.from({ length: 130 }, (_, index) => index + 1))
              expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
            } finally {
              release.resolve()
              await pumping.catch(() => {})
            }
          },
        }),
      )
    })

    test("a failed batch replays stable identities after actual Runtime restart without partial acknowledgment", async () => {
      await using directory = await tmpdir()
      const namespace = crypto.randomUUID()
      const attempts: StorageEventSinks.Delivery[][] = []
      const lost = new Error("Original batch receiver acknowledgment lost")
      let fail = true
      const sink = {
        id: "batch-receiver",
        capture,
        async deliver() {
          throw new Error("Native receiver requires its bounded batch contract")
        },
        async deliverBatch(deliveries: readonly Readonly<StorageEventSinks.Delivery>[]) {
          attempts.push(structuredClone([...deliveries]))
          await Storage.transaction(async () => {
            for (const value of deliveries) {
              const receipt = ["original-batch-receipt", value.eventID]
              const [previous] = await Storage.readMany([receipt])
              if (previous === undefined) await Storage.write(receipt, value)
              else expect(previous).toEqual(value)
            }
          })
          if (fail) throw lost
        },
      }
      const open = () =>
        testRuntime({
          home: directory.path,
          namespace,
          postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
          register: () => StorageEventSinks.register(sink),
        })
      {
        await using runtime = await open()
        await runtime.run(() =>
          ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              await Storage.transaction(async () => {
                for (const value of [1, 2, 3]) await Bus.publish(Changed, { partition: "run-a", value })
              })
              await expect(StorageEventSinks.flush()).rejects.toBe(lost)
              expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(3)
              expect(await Storage.query({ kind: "original-batch-receipt" })).toHaveLength(3)
            },
          }),
        )
      }
      fail = false
      await using reopened = await open()
      await reopened.run(async () => {
        expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(3)
        expect(await StorageEventSinks.flush()).toEqual({ delivered: 3 })
        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toEqual(attempts[0])
        expect(await Storage.query({ kind: "original-batch-receipt" })).toHaveLength(3)
        expect(await Storage.query({ kind: "event_delivery" })).toEqual([])
      })
    })

    test("batch acknowledgment preserves every original row when one actual delivery revision changes", async () => {
      const sink = {
        id: "batch-receiver",
        capture,
        async deliver() {
          throw new Error("Native receiver requires its bounded batch contract")
        },
        async deliverBatch(deliveries: readonly Readonly<StorageEventSinks.Delivery>[]) {
          expect(deliveries.map((value) => value.sequence)).toEqual([1, 2])
          const record = (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" }))[1]!
          await Storage.write(record.key, { ...record.value, payload: { changed: true } })
        },
      }
      await using runtime = await testRuntime({
        postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
        register: () => StorageEventSinks.register(sink),
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            await Storage.transaction(async () => {
              for (const value of [1, 2]) await Bus.publish(Changed, { partition: "run-a", value })
            })
            await expect(StorageEventSinks.flush()).rejects.toThrow("changed while awaiting acknowledgment")
            expect(
              (await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })).map(
                (row) => row.value.sequence,
              ),
            ).toEqual([1, 2])
          },
        }),
      )
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

test("a selected durable partition cannot consume another blocked partition or imply global drainage", async () => {
  const accepted: string[] = []
  await using runtime = await testRuntime({
    register: () =>
      StorageEventSinks.register({
        id: "scoped-delivery",
        capture,
        async deliver(value) {
          if (value.partition === "blocked") throw new Error("Original partition is frozen")
          accepted.push(value.eventID)
        },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await Storage.transaction(async () => {
          await Bus.publish(Changed, { partition: "blocked", value: 1 })
          await Bus.publish(Changed, { partition: "healthy", value: 2 })
        })
        const before = await Storage.query<StorageEventSinks.Delivery>({ kind: "event_delivery" })
        const blocked = before.find((row) => row.value.partition === "blocked")!
        const healthy = before.find((row) => row.value.partition === "healthy")!
        expect(await StorageEventSinks.flush({ sinkID: "scoped-delivery", partition: "healthy" })).toEqual({
          delivered: 1,
        })
        expect(accepted).toEqual([healthy.value.eventID])
        expect(await Storage.query({ kind: "event_delivery" })).toEqual([blocked])
        await expect(StorageEventSinks.flush({ sinkID: "scoped-delivery", partition: "blocked" })).rejects.toThrow(
          "Original partition is frozen",
        )
        expect(await Storage.query({ kind: "event_delivery" })).toEqual([blocked])
        expect(await StorageEventSinks.flush({ sinkID: "scoped-delivery", partition: "healthy" })).toEqual({
          delivered: 0,
        })
        expect(await Storage.query({ kind: "event_delivery" })).toHaveLength(1)
        await expect(StorageEventSinks.flush({ partition: "healthy" })).rejects.toThrow("requires its sink identity")
      },
    }),
  )
})
