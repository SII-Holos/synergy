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
        const usage = ["usage_time", "scope", `operation_${index % 2}`, String(index).padStart(6, "0")]
        await tx.write(usage, value)
        expected.set(JSON.stringify(usage), value)
        const marker = ["markers", String(index).padStart(6, "0")]
        await tx.write([...marker, "nested"], value)
        expected.set(JSON.stringify([...marker, "nested"]), value)
        if (index % 3) {
          await tx.write(marker, value)
          if (index % 19 === 0) await tx.remove(marker)
          else expected.set(JSON.stringify(marker), value)
        }
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
      if (statement.startsWith("WITH ") || (statement.startsWith("SELECT") && statement.includes("storage_records"))) {
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

test("direct child pages bound record probes and retain cursors across empty pages", async () => {
  for (const descending of [false, true]) {
    const { tx, plans } = transaction()
    try {
      const keys: string[][] = []
      let after: string | undefined
      let empty = 0
      do {
        const page = await tx.childKeys({ prefix: ["markers"], after, limit: 1, descending, before: "000020" })
        keys.push(...page.keys)
        if (!page.keys.length && page.after) empty++
        after = page.after
      } while (after)
      const sorted = [...expected.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((key) => key[0] === "markers" && key.length === 2 && key[1]! < "000020")
        .sort()
      expect(keys).toEqual(descending ? sorted.toReversed() : sorted)
      expect(empty).toBeGreaterThan(0)
      expect(
        plans
          .filter((plan) => /(?:SEARCH|SCAN) record\b/.test(plan))
          .every((plan) => /namespace=\? AND key_id=\?/.test(plan)),
      ).toBe(true)
      expect(plans.some((plan) => plan.includes("MATERIALIZE candidates"))).toBe(true)
      expect(await tx.childKeys({ prefix: ["missing"] })).toEqual({ keys: [], after: undefined })
      await expect(tx.childKeys({ prefix: ["markers"], limit: 0 })).rejects.toThrow("Invalid storage page limit")
    } finally {
      tx.finish()
    }
  }
})

test("prefix traversal probes only descendant records, including an absent recovery root", async () => {
  for (const prefix of [["first"], ["storage_staging"], ["first", "foreign"]]) {
    const { tx, plans } = transaction()
    try {
      const keys = [...expected.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((key) => key.length > prefix.length && prefix.every((part, index) => key[index] === part))
      expect(await tx.scan(prefix)).toEqual([...new Set(keys.map((key) => key[prefix.length]))].sort())
      expect(await tx.list(prefix)).toEqual(keys.sort())
      const recordPlans = plans.filter((plan) => /(?:SEARCH|SCAN) record\b/.test(plan))
      expect(recordPlans).toHaveLength(2)
      expect(recordPlans.every((plan) => /namespace=\? AND key_id=\?/.test(plan))).toBe(true)
    } finally {
      tx.finish()
    }
  }
})

test("child enumeration stops at live evidence instead of collecting every descendant", async () => {
  for (const prefix of [[], ["first"], ["first", "19"], ["missing"]]) {
    const { tx, plans } = transaction()
    try {
      const keys = [...expected.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((key) => key.length > prefix.length && prefix.every((part, index) => key[index] === part))
      expect(await tx.scan(prefix)).toEqual([...new Set(keys.map((key) => key[prefix.length]))].sort())
      expect(plans.some((plan) => plan.includes("CORRELATED SCALAR SUBQUERY"))).toBe(true)
      expect(plans.some((plan) => plan.includes("TEMP B-TREE"))).toBe(false)
    } finally {
      tx.finish()
    }
  }
})

test("filtered cursor pages seek into their index in both directions", async () => {
  for (const descending of [false, true]) {
    const { tx, plans } = transaction()
    try {
      const first = await tx.query({ kind: "first", limit: 30, descending })
      plans.length = 0
      const second = await tx.query({ kind: "first", limit: 30, descending, after: first.at(-1)!.key })
      const keys = await tx.queryKeys({ kind: "first", limit: 30, descending, after: first.at(-1)!.key })
      expect(keys).toEqual(second.map((record) => record.key))
      expect(second).toHaveLength(30)
      expect(new Set([...first, ...second].map((row) => JSON.stringify(row.key))).size).toBe(60)
      expect(plans.join("\n")).toMatch(/order_key.*[<>]/)
      expect(plans.join("\n")).not.toContain("TEMP B-TREE")
    } finally {
      tx.finish()
    }
  }
})

test("prefix cursor pages retain indexed range seeks without sorting their full history", async () => {
  for (const descending of [false, true]) {
    const { tx, plans } = transaction()
    try {
      let after: string[] | undefined
      const seen: string[][] = []
      for (;;) {
        plans.length = 0
        const page = await tx.query({
          kind: "usage_time",
          scopeID: "scope",
          sessionID: "",
          prefix: ["usage_time", "scope", "operation_1"],
          limit: 30,
          descending,
          after,
        })
        const detail = plans.join("\n")
        expect(detail).toMatch(/storage_records_(kind|session)/)
        expect(detail).not.toContain("SCAN storage_records")
        expect(detail).not.toContain("TEMP B-TREE")
        if (after) expect(detail).toMatch(/order_key.*[<>]/)
        if (!page.length) break
        seen.push(...page.map((row) => row.key))
        after = page.at(-1)!.key
      }
      expect(seen).toEqual(
        (await tx.query({ kind: "usage_time", descending, limit: 1000 }))
          .filter((row) => row.key[2] === "operation_1")
          .map((row) => row.key),
      )
    } finally {
      tx.finish()
    }
  }
})

test("prefix-only pages and counts probe their subtree instead of unrelated history", async () => {
  for (const prefix of [["first"], ["first", "101"], ["first", "101", "3"], ["missing"]]) {
    for (const descending of [false, true]) {
      const { tx, plans } = transaction()
      try {
        const expectedKeys = (await tx.query({ kind: "first", descending, limit: 1000 }))
          .map((row) => row.key)
          .filter((key) => prefix.every((part, index) => key[index] === part))
        plans.length = 0
        const keys: string[][] = []
        let after: string[] | undefined
        for (;;) {
          const page = await tx.queryKeys({ prefix, descending, after, limit: 30 })
          if (!page.length) break
          keys.push(...page)
          after = page.at(-1)
        }
        expect(keys).toEqual(expectedKeys)
        expect(await tx.count({ prefix })).toBe(expectedKeys.length)
        const recordPlans = plans.filter((plan) => /(?:SEARCH|SCAN) storage_records\b/.test(plan))
        expect(recordPlans.length).toBeGreaterThan(0)
        expect(recordPlans.every((plan) => /namespace=\? AND key_id=\?/.test(plan))).toBe(true)
      } finally {
        tx.finish()
      }
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
    expect(plans.filter((plan) => /SEARCH (r|storage_records) /.test(plan)).every((plan) => /key_id>/.test(plan))).toBe(
      true,
    )
  } finally {
    tx.finish()
  }
})
