import { expect, test } from "bun:test"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { StorageEventSinks } from "../../src/storage/event-sinks"
import { StorageMutationGuard } from "../../src/storage/mutation-guard"
import type { SqlQueryOptions, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import type { StoredEvent, StoreTransaction } from "../../src/storage/transactional-store"
import { testRuntime } from "../support/runtime"

const sinkID = "capture-work"
const partition = "original"
const meta = ["event_delivery_meta", sinkID, partition]
const key = (sequence: number) => ["event_delivery", sinkID, partition, String(sequence).padStart(16, "0")]
const event = (scopeID: string, id: string, value: number): StoredEvent => ({
  id,
  scopeID,
  type: "test.capture-work",
  payload: { value },
})
const capture: StorageEventSinks.Sink["capture"] = (value) =>
  value.type === "test.capture-work" ? { partition, payload: value.payload } : undefined

function delivery(value: StoredEvent, sequence: number): StorageEventSinks.Delivery {
  return { version: 1, sinkID, eventID: value.id, partition, sequence, payload: value.payload }
}

test("one captured event bounds SQL dispatch and preserves facts, ordered receipts and rollback", async () => {
  const failure = new Error("captured receipt failed")
  const work: number[] = []
  const staged: StorageEventSinks.Delivery[] = []
  const guarded: string[][][] = []
  let stopMeasurement: (() => void) | undefined
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("capture-work", async (_tx, keys) => {
        if (keys.some((value) => value[0] === "event_delivery_meta" || value[0] === "event_delivery"))
          guarded.push(keys.map((value) => [...value]))
      })
      StorageEventSinks.register({
        id: sinkID,
        capture,
        async deliver() {},
        async captured(value) {
          stopMeasurement?.()
          expect(Storage.inWriteTransaction()).toBeTrue()
          expect(await Storage.readMany([meta, key(value.sequence)])).toEqual([{ sequence: value.sequence }, value])
          staged.push(structuredClone(value))
          await Storage.write(["capture-receipt", value.eventID], { sequence: value.sequence })
          if ((value.payload as { value: number }).value === -1) throw failure
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const original = [event(scopeID, "first", 1), event(scopeID, "second", 2), event(scopeID, "third", 3)]
        const measure = async (tx: StoreTransaction, value: StoredEvent) => {
          const raw = tx.raw
          const query = raw.query
          let measuring = true
          let dispatches = 0
          stopMeasurement = () => {
            measuring = false
          }
          raw.query = <Row extends SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions) => {
            if (measuring) dispatches++
            return query<Row>(statement, values, options)
          }
          try {
            await Storage.capture(value)
          } finally {
            measuring = false
            stopMeasurement = undefined
            raw.query = query
            work.push(dispatches)
          }
        }
        await Storage.transaction(async (tx) => {
          for (const value of original) {
            await Storage.write(["capture-fact", scopeID, value.id], value.payload)
            await measure(tx, value)
          }
        })
        const committed = original.map((value, index) => delivery(value, index + 1))
        expect(staged).toEqual(committed)
        expect(await Storage.readMany(original.map((value) => ["capture-fact", scopeID, value.id]))).toEqual(
          original.map((value) => value.payload),
        )
        expect(await Storage.readMany([meta, ...committed.map((value) => key(value.sequence))])).toEqual([
          { sequence: 3 },
          ...committed,
        ])
        expect(await Storage.readMany(original.map((value) => ["capture-receipt", value.id]))).toEqual([
          { sequence: 1 },
          { sequence: 2 },
          { sequence: 3 },
        ])
        const rejected = event(scopeID, "rolled-back", -1)
        const outcome = await Storage.transaction(async (tx) => {
          await Storage.write(["capture-fact", scopeID, rejected.id], rejected.payload)
          await measure(tx, rejected)
        }).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        expect(outcome.kind).toBe("rejected")
        if (outcome.kind === "rejected") expect(outcome.error).toBe(failure)
        expect(staged).toEqual([...committed, delivery(rejected, 4)])
        expect(
          await Storage.readMany([["capture-fact", scopeID, rejected.id], ["capture-receipt", rejected.id], key(4)]),
        ).toEqual([undefined, undefined, undefined])
        expect(await Storage.readMany([meta, ...committed.map((value) => key(value.sequence))])).toEqual([
          { sequence: 3 },
          ...committed,
        ])
        expect(await Storage.current().store.pendingEvents()).toEqual([])
        // Meta selection + two fresh maintenance checks + bulk prior rows/nodes/records.
        expect(work).toEqual([6, 6, 6, 6])
        expect(guarded.flat()).toEqual([1, 2, 3, 4].flatMap((sequence) => [meta, key(sequence)]))
      },
    }),
  )
})

test("capture guards freshly read same-transaction authority for the complete publication keys", async () => {
  const authorityKey = ["capture-authority"]
  const failure = new Error("capture authority changed")
  const observations: Array<{ allowed: boolean; keys: string[][] }> = []
  const staged: number[] = []
  await using runtime = await testRuntime({
    register() {
      StorageMutationGuard.register("capture-authority", async (tx, keys) => {
        if (!keys.some((value) => value[0] === "event_delivery_meta" || value[0] === "event_delivery")) return
        const [authority] = await tx.readMany<{ allowed: boolean }>([authorityKey])
        const allowed = authority?.allowed === true
        observations.push({ allowed, keys: keys.map((value) => [...value]) })
        if (!allowed) throw failure
      })
      StorageEventSinks.register({
        id: sinkID,
        capture,
        async deliver() {},
        async captured(value) {
          expect(await Storage.readMany([meta, key(value.sequence)])).toEqual([{ sequence: value.sequence }, value])
          staged.push(value.sequence)
          await Storage.write(["capture-receipt", value.eventID], { sequence: value.sequence })
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const scopeID = ScopeContext.current.scope.id
        const first = event(scopeID, "committed", 1)
        await Storage.transaction(async () => {
          await Storage.write(authorityKey, { allowed: true })
          await Storage.write(["capture-fact", scopeID], first.payload)
          await Storage.capture(first)
        })
        const second = event(scopeID, "accepted-then-rolled-back", 2)
        const third = event(scopeID, "denied", 3)
        const outcome = await Storage.transaction(async () => {
          await Storage.write(["capture-fact", scopeID], second.payload)
          await Storage.capture(second)
          await Storage.write(authorityKey, { allowed: false })
          await Storage.capture(third)
        }).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        expect(outcome.kind).toBe("rejected")
        if (outcome.kind === "rejected") expect(outcome.error).toBe(failure)
        expect(staged).toEqual([1, 2])
        expect(observations.filter((value) => value.allowed).flatMap((value) => value.keys)).toEqual([
          meta,
          key(1),
          meta,
          key(2),
        ])
        const denied = observations.filter((value) => !value.allowed)
        expect(denied).toHaveLength(1)
        expect(denied[0].keys).toContainEqual(meta)
        expect(
          await Storage.readMany([
            authorityKey,
            ["capture-fact", scopeID],
            meta,
            key(1),
            key(2),
            key(3),
            ["capture-receipt", first.id],
            ["capture-receipt", second.id],
            ["capture-receipt", third.id],
          ]),
        ).toEqual([
          { allowed: true },
          first.payload,
          { sequence: 1 },
          delivery(first, 1),
          undefined,
          undefined,
          { sequence: 1 },
          undefined,
          undefined,
        ])
      },
    }),
  )
})
