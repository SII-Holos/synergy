import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import type { SqlConnection, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "storage-traversal-"))
const filename = path.join(root, "records.sqlite")
const expected = new Map<string, unknown>()
let database: Database

beforeAll(async () => {
  const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "traversal" })
  try {
    await store.transaction(async (tx) => {
      for (let index = 0; index < 600; index++) {
        const key = [index % 2 ? "first" : "second", String(index), String(index % 7)]
        const value = { index, future: { preserved: true } }
        await tx.write(key, value)
        if (index % 19 === 0) await tx.remove(key)
        else expected.set(JSON.stringify(key), value)
      }
    })
  } finally {
    await store.close()
  }
  const other = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "other" })
  try {
    await other.write(["first", "foreign"], { hidden: true })
  } finally {
    await other.close()
  }
  initializeSqliteEngine()
  database = new Database(filename, { readonly: true })
}, 20000)

afterAll(async () => {
  database?.close()
  await fs.rm(root, { recursive: true, force: true })
})

function transaction() {
  const plans: string[] = []
  const connection: SqlConnection = {
    async query<Row extends SqlRow>(statement: string, values: SqlValue[] = []) {
      if (statement.startsWith("SELECT") && statement.includes("FROM storage_records")) {
        const plan = database.query<{ detail: string }, SqlValue[]>("EXPLAIN QUERY PLAN " + statement)
        plans.push(...plan.all(...values).map((row) => row.detail))
        plan.finalize()
      }
      const query = database.query<Row, SqlValue[]>(statement)
      try {
        return query.all(...values)
      } finally {
        query.finalize()
      }
    },
  }
  return { tx: new StoreTransaction(connection, "traversal", true), plans }
}

test("filtered cursor pages seek into their index in both directions", async () => {
  for (const descending of [false, true]) {
    const { tx, plans } = transaction()
    try {
      const first = await tx.query({ kind: "first", limit: 30, descending })
      plans.length = 0
      const second = await tx.query({ kind: "first", limit: 30, descending, after: first.at(-1)!.key })
      expect(second).toHaveLength(30)
      expect(new Set([...first, ...second].map((row) => JSON.stringify(row.key))).size).toBe(60)
      expect(plans.join("\n")).toMatch(/order_key.*[<>]/)
      expect(plans.join("\n")).not.toContain("TEMP B-TREE")
    } finally {
      tx.finish()
    }
  }
})

test("complete exports traverse the existing key index without repeated sorting", async () => {
  const { tx, plans } = transaction()
  try {
    const actual = new Map<string, unknown>()
    for await (const entry of tx.exportEntries()) {
      expect(entry.type).toBe("record")
      if (entry.type !== "record") continue
      const key = JSON.stringify(entry.key)
      expect(actual.has(key)).toBe(false)
      expect(entry.revision).toBe("1")
      actual.set(key, entry.value)
    }
    expect(actual).toEqual(expected)
    expect(plans.length).toBeGreaterThan(2)
    expect(plans.join("\n")).not.toContain("TEMP B-TREE")
    expect(plans.every((plan) => /key_id>/.test(plan))).toBe(true)
  } finally {
    tx.finish()
  }
})
