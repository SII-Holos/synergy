import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { RecordCodec } from "../../src/storage/record-codec"
import { TransactionalStore } from "../../src/storage/transactional-store"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "event-receipt-encoding-"))
const stores: TransactionalStore[] = []

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => {})))
  await fs.rm(root, { recursive: true, force: true })
})

async function open(label: string) {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: label,
    filename: path.join(root, `${label}.sqlite`),
  })
  stores.push(store)
  return store
}

/** The column as the engine stored it, without going through the store's readers. */
function stored(filename: string, table: "storage_events" | "storage_receipts", column: "payload" | "result") {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const [row] = database
      .query<
        { kind: string; value: string | Uint8Array },
        []
      >(`SELECT typeof(${column}) AS kind, ${column} AS value FROM ${table}`)
      .all()
    return row!
  } finally {
    database.close()
  }
}

/**
 * A body large enough that `RecordCodec` stores it as a compressed frame rather
 * than as plain JSON. This is the form the record-body column holds.
 */
const compressibleValue = { text: "durable rollout evidence".repeat(200) }
const smallValue = { v: 1 }

test("a compressed frame is not the form these two columns hold, which is why the readers parse JSON", async () => {
  // The premise the cleanup decision turns on: `RecordCodec` genuinely chooses the
  // frame for a value this size, while the value a smaller one produces stays
  // plain. `StorageEntry.result` is a string in the portable archive, and both
  // readers parse the column as JSON text.
  expect(RecordCodec.encode(compressibleValue)).toBeInstanceOf(Uint8Array)
  expect(RecordCodec.encode(smallValue)).toBe('{"v":1}')
})

test("event payloads and command receipts round-trip at both sizes through the serving readers", async () => {
  const store = await open("encoding-roundtrip")

  await store.transaction(async (tx) => {
    await tx.enqueue({ id: "event-small", scopeID: "scope", type: "small", payload: smallValue })
    await tx.enqueue({ id: "event-large", scopeID: "scope", type: "large", payload: compressibleValue })
  })
  // `pendingEvents` orders by position, so insertion order is the read order.
  expect(await store.pendingEvents(10)).toEqual([
    { id: "event-small", scopeID: "scope", type: "small", payload: smallValue },
    { id: "event-large", scopeID: "scope", type: "large", payload: compressibleValue },
  ])

  // The oversized receipt proves the column survives a value far past the
  // compression floor, and replay reads it back through the same shape.
  await store.transaction(
    async (tx) => {
      await tx.write(["probe"], { ok: true })
      return { ok: true }
    },
    { operationID: "receipt-large", requestHash: "input-large" },
  )
  expect(await store.operationReceipt("receipt-large")).toEqual({
    requestHash: "input-large",
    result: { value: { ok: true } },
  })
  expect(
    await store.transaction(
      async (tx) => {
        await tx.write(["probe"], { replayed: true })
        return { ok: true }
      },
      { operationID: "receipt-large", requestHash: "input-large" },
    ),
  ).toEqual({ ok: true })
})

test("both columns hold JSON text rather than a frame, for a value above the compression floor", async () => {
  const store = await open("encoding-columns")
  const filename = store.sqliteFilename!

  await store.transaction(
    async (tx) => {
      await tx.enqueue({ id: "event", scopeID: "scope", type: "large", payload: compressibleValue })
      await tx.write(["probe"], { ok: true })
      return { ok: true }
    },
    { operationID: "receipt", requestHash: "input" },
  )

  const payload = stored(filename, "storage_events", "payload")
  const result = stored(filename, "storage_receipts", "result")

  // This is the evidence that routing the writers through `RecordCodec.encode` is
  // not a two-line swap. The column holds the plain JSON of a value the codec would
  // have stored as a frame, and every reader of both columns -- `pendingEvents`,
  // `exportEntries`, `operationReceipt`, the receipt replay in `transaction`, and
  // `restoreEntry`'s string comparison -- parses or compares that text directly. A
  // frame here is a `Uint8Array`, which those readers cannot parse, and on
  // PostgreSQL a `Uint8Array` bound to this declared-`TEXT` column lands as
  // `\x`-escaped text rather than as bytes.
  expect(String(payload.kind)).toBe("text")
  expect(String(result.kind)).toBe("text")
  expect(JSON.parse(String(payload.value))).toEqual(compressibleValue)
  expect(JSON.parse(String(result.value))).toEqual({ value: { ok: true } })
  // The two forms are genuinely different: the frame the codec would choose is not
  // the text these columns actually hold.
  expect(RecordCodec.encode(compressibleValue)).not.toBe(payload.value)
})
