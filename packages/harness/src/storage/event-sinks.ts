import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "./storage"
import { StorageIntegrityError } from "./errors"
import type { StoredEvent, StoreTransaction, TransactionalStore } from "./transactional-store"

export namespace StorageEventSinks {
  const DeliverySchema = z
    .object({
      version: z.literal(1),
      sinkID: z.string().min(1),
      eventID: z.string().min(1),
      partition: z.string().min(1).max(256),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      payload: z.unknown(),
    })
    .strict()
  export type Delivery = z.infer<typeof DeliverySchema>
  export interface Sink {
    id: string
    /** Pure selection and projection inside the fact's transaction; no external effects. */
    capture(event: Readonly<StoredEvent>): { partition: string; payload: unknown } | undefined
    /** Acknowledges durable acceptance. Receivers deduplicate by eventID and sinkID. */
    deliver(delivery: Readonly<Delivery>): Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    sinks: new Map<string, Sink>(),
    flushing: new WeakMap<TransactionalStore, Promise<unknown>>(),
  }))

  export function register(sink: Sink) {
    RuntimeContext.assertCompositionOpen("storage event sinks")
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sink.id)) throw new Error("Invalid storage event sink identity")
    const existing = state().sinks.get(sink.id)
    if (existing === sink) return
    if (existing) throw new Error(`Storage event sink ${sink.id} is already registered`)
    state().sinks.set(sink.id, sink)
  }

  /** Called by Storage.enqueue; the external queue is independent of Runtime Bus epochs. */
  export async function capture(tx: StoreTransaction, event: StoredEvent) {
    for (const sink of state().sinks.values()) {
      const selected = sink.capture(structuredClone(event))
      if (selected === undefined) continue
      const partition = z.string().min(1).max(256).parse(selected.partition)
      const meta = ["event_delivery_meta", sink.id, partition]
      const [previous] = await tx.readMany<{ sequence: number }>([meta])
      const sequence = (previous?.sequence ?? 0) + 1
      const delivery = DeliverySchema.parse({
        version: 1,
        sinkID: sink.id,
        eventID: event.id,
        partition,
        sequence,
        payload: structuredClone(selected.payload),
      })
      await tx.write(meta, { sequence })
      await tx.write(key(delivery), delivery)
    }
  }

  /** Hosts explicitly pump bounded batches before admission and while serving, then drain on shutdown. */
  export async function flush(options: { limit?: number } = {}): Promise<{ delivered: number }> {
    if (Storage.inTransaction()) throw new Error("Flush storage event sinks outside a transaction")
    const limit = z
      .number()
      .int()
      .min(1)
      .max(1024)
      .parse(options.limit ?? 128)
    const { store } = Storage.current()
    const current = state()
    const pending = (current.flushing.get(store) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const records = await Storage.query<Delivery>({ kind: "event_delivery", limit })
        let delivered = 0
        for (const record of records) {
          const delivery = DeliverySchema.parse(record.value)
          if (JSON.stringify(key(delivery)) !== JSON.stringify(record.key))
            throw new StorageIntegrityError("External event delivery identity does not match its record")
          const sink = current.sinks.get(delivery.sinkID)
          if (!sink) throw new StorageIntegrityError(`Storage event sink ${delivery.sinkID} is not registered`)
          await sink.deliver(structuredClone(delivery))
          await Storage.transaction(async (tx) => {
            const latest = await tx.versioned<Delivery>(record.key)
            if (latest.revision !== record.revision)
              throw new StorageIntegrityError("External event delivery changed while awaiting acknowledgment")
            await tx.remove(record.key)
          })
          delivered++
        }
        return { delivered }
      })
    current.flushing.set(store, pending)
    try {
      return await pending
    } finally {
      if (current.flushing.get(store) === pending) current.flushing.delete(store)
    }
  }

  function key(delivery: Delivery) {
    return ["event_delivery", delivery.sinkID, delivery.partition, String(delivery.sequence).padStart(16, "0")]
  }
}
