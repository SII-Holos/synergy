import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { RecordCodec } from "../../src/storage/record-codec"
import { StoragePortable } from "../../src/storage/portable"
import { TransactionalStore, type StoredEvent } from "../../src/storage/transactional-store"

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
function storedBody(
  filename: string,
  table: "storage_events" | "storage_receipts",
  column: "payload" | "result",
  row: { column: "id" | "operation_id"; value: string },
) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const [record] = database
      .query<
        { kind: string; value: string | Uint8Array },
        [string]
      >(`SELECT typeof(${column}) AS kind, ${column} AS value FROM ${table} WHERE ${row.column} = ?`)
      .all(row.value)
    return record!
  } finally {
    database.close()
  }
}

/**
 * A body large enough that `RecordCodec` stores it as a compressed frame rather
 * than as plain JSON.
 */
const compressibleValue = { text: "durable rollout evidence".repeat(200), nested: { unknown: true } }
const smallValue = { v: 1 }

test("the codec chooses the frame form for a compressible value and keeps a small one as plain JSON", () => {
  expect(RecordCodec.encode(compressibleValue)).toBeInstanceOf(Uint8Array)
  expect(RecordCodec.encode(smallValue)).toBe('{"v":1}')
})

test("both columns hold the codec's frame form above the compression floor and stay readable", async () => {
  const store = await open("encoding-columns")
  const filename = store.sqliteFilename!

  await store.transaction(
    async (tx) => {
      await tx.enqueue({ id: "event-small", scopeID: "scope", type: "small", payload: smallValue })
      await tx.enqueue({ id: "event-large", scopeID: "scope", type: "large", payload: compressibleValue })
      await tx.write(["probe"], { ok: true })
      return { nested: { value: compressibleValue } }
    },
    { operationID: "receipt-large", requestHash: "input-large" },
  )

  // The columns follow the format 3 container rule the body column uses, so a
  // value the codec compresses is written as a real frame. This is the assertion
  // that replaces the retired bypass: a local `JSON.stringify` could only ever
  // leave text here.
  expect(String(storedBody(filename, "storage_events", "payload", { column: "id", value: "event-large" }).kind)).toBe(
    "blob",
  )
  expect(
    String(storedBody(filename, "storage_receipts", "result", { column: "operation_id", value: "receipt-large" }).kind),
  ).toBe("blob")

  const payload = storedBody(filename, "storage_events", "payload", { column: "id", value: "event-large" })
  const result = storedBody(filename, "storage_receipts", "result", { column: "operation_id", value: "receipt-large" })
  expect(payload.value).toBeInstanceOf(Uint8Array)
  expect(result.value).toBeInstanceOf(Uint8Array)
  expect(RecordCodec.decode<typeof compressibleValue>(payload.value)).toEqual(compressibleValue)
  expect(RecordCodec.decode<{ value: unknown }>(result.value)).toEqual({
    value: { nested: { value: compressibleValue } },
  })
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

  // A receipt carries a nested result far past the compression floor, so the
  // replay path has to decode a frame rather than parse the column as text.
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
  await expect(
    store.transaction(async () => "other", { operationID: "receipt-large", requestHash: "other-input" }),
  ).rejects.toThrow("Operation ID was already used for different input")
})

test("a receipt and an event written before this change stay readable as plain text", async () => {
  const namespace = "encoding-legacy-read"
  const store = await open(namespace)
  const filename = store.sqliteFilename!

  // The retired writer stored `JSON.stringify` output directly, which is exactly
  // the plain JSON form the codec leaves unchanged. Both readers must still
  // accept it.
  await store.transaction(async (tx) => {
    await tx.raw.query(
      "INSERT INTO storage_events(namespace, id, scope_id, type, payload, position) VALUES (?, ?, ?, ?, ?, ?)",
      [namespace, "legacy-event", "scope", "legacy", JSON.stringify(smallValue), 1],
    )
    await tx.raw.query(
      "INSERT INTO storage_receipts(namespace, operation_id, request_hash, result, created) VALUES (?, ?, ?, ?, ?)",
      [namespace, "legacy-receipt", "legacy-input", JSON.stringify({ value: smallValue }), 1],
    )
  })

  expect(String(storedBody(filename, "storage_events", "payload", { column: "id", value: "legacy-event" }).kind)).toBe(
    "text",
  )
  expect(await store.pendingEvents(10)).toEqual<StoredEvent[]>([
    { id: "legacy-event", scopeID: "scope", type: "legacy", payload: smallValue },
  ])
  expect(await store.operationReceipt("legacy-receipt")).toEqual({
    requestHash: "legacy-input",
    result: { value: smallValue },
  })
})

test("restoreEntry compares decoded JSON text, so a framed receipt matches its archive string", async () => {
  const store = await open("encoding-restore")
  const filename = store.sqliteFilename!
  const result = { nested: { value: compressibleValue } }

  await store.transaction(
    async (tx) => {
      await tx.write(["probe"], { ok: true })
      return result
    },
    { operationID: "receipt", requestHash: "input" },
  )
  const stored = storedBody(filename, "storage_receipts", "result", { column: "operation_id", value: "receipt" })
  expect(stored.value).toBeInstanceOf(Uint8Array)

  // The archive carries JSON text while the column holds a frame. An equality
  // test against the raw column would call this an identical receipt a conflict.
  await store.transaction(async (tx) => {
    await tx.restoreEntry({
      type: "receipt",
      operationID: "receipt",
      requestHash: "input",
      result: RecordCodec.text(stored.value as Uint8Array),
      created: 1,
    })
  })

  await expect(
    store.transaction(async (tx) => {
      await tx.restoreEntry({
        type: "receipt",
        operationID: "receipt",
        requestHash: "input",
        result: JSON.stringify({ value: { different: true } }),
        created: 1,
      })
    }),
  ).rejects.toThrow("Command receipt conflicts with existing target data")
})

test("a portable export and import round-trips both columns exactly", async () => {
  const source = await open("encoding-portable-source")
  const namespace = "encoding-portable-source"
  const target = await open("encoding-portable-target")
  const archive = path.join(root, "encoding-archive.ndjson")

  await source.transaction(
    async (tx) => {
      await tx.enqueue({ id: "event-small", scopeID: "scope", type: "small", payload: smallValue })
      await tx.enqueue({ id: "event-large", scopeID: "scope", type: "large", payload: compressibleValue })
      await tx.write(["probe"], { ok: true })
      return { nested: { value: compressibleValue } }
    },
    { operationID: "receipt-large", requestHash: "input-large" },
  )
  // A legacy plain-text row travels through the same archive as a framed one.
  await source.transaction(async (tx) => {
    await tx.raw.query(
      "INSERT INTO storage_events(namespace, id, scope_id, type, payload, position) VALUES (?, ?, ?, ?, ?, ?)",
      [namespace, "event-legacy", "scope", "legacy", JSON.stringify(smallValue), 99],
    )
  })

  // The envelope is JSON, so the frame both columns hold must be rendered back
  // to the JSON text the portable format carries.
  const exported = await source.snapshot(async (tx) => Array.fromAsync(tx.exportEntries()))
  const receipt = exported.find((entry) => entry.type === "receipt")
  expect(receipt?.type === "receipt" && typeof receipt.result === "string").toBe(true)
  expect(exported.some((entry) => entry.type === "event")).toBe(true)

  await StoragePortable.exportFile(source, archive)
  await StoragePortable.importFile(target, archive)

  expect(await target.pendingEvents(10)).toEqual(await source.pendingEvents(10))
  expect(await target.operationReceipt("receipt-large")).toEqual(await source.operationReceipt("receipt-large"))
  // The imported columns take the codec's form again rather than the archive's.
  const imported = storedBody(target.sqliteFilename!, "storage_receipts", "result", {
    column: "operation_id",
    value: "receipt-large",
  })
  expect(imported.value).toBeInstanceOf(Uint8Array)
  expect(RecordCodec.decode<{ value: unknown }>(imported.value)).toEqual({
    value: { nested: { value: compressibleValue } },
  })
})
