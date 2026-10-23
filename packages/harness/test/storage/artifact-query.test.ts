import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import type { SqlConnection, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"
import { createV2Store } from "./format-v3-fixture"

test("artifact replacement seeks by key and deduplicates shared-pack collection intents", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-query-"))
  const filename = path.join(root, "records.sqlite")
  const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "artifacts" })
  await store.close()
  initializeSqliteEngine()
  const database = new Database(filename)
  const plans: string[] = []
  const connection: SqlConnection = {
    async query<Row extends SqlRow>(statement: string, values: SqlValue[] = []) {
      if (statement.startsWith("INSERT INTO storage_artifact_gc")) {
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
  const tx = new StoreTransaction(connection, "artifacts", false)
  const location = {
    pack: crypto.randomUUID() + ".pack",
    codec: "raw" as const,
    blockOffset: 0,
    blockBytes: 1,
    decodedBytes: 1,
    offset: 0,
    size: 1,
    sha256: "0".repeat(64),
  }
  try {
    database.run("BEGIN")
    const entries = Array.from({ length: 256 }, (_, n) => ({ key: ["blobs", String(n)], location }))
    await tx.writeArtifacts(entries)
    plans.length = 0
    const replacement = { ...location, pack: crypto.randomUUID() + ".pack" }
    await tx.writeArtifacts(entries.slice(0, 128).map((entry) => ({ ...entry, location: replacement })))
    const garbage = await tx.artifactGarbage()
    expect(garbage).toEqual([{ pack: location.pack, used: true }])
    expect(plans.some((plan) => /namespace=\? AND key_text=\?/.test(plan))).toBe(true)
    expect(plans.some((plan) => /storage_artifacts_pack.*\(namespace=\?\)/.test(plan))).toBe(false)
    await tx.writeArtifacts(entries.slice(128).map((entry) => ({ ...entry, location: replacement })))
    expect(await tx.artifactGarbage()).toEqual([{ pack: location.pack, used: false }])
    plans.length = 0
    await tx.removeTree(["blobs"])
    expect(plans.some((plan) => /namespace=\? AND key_text>\? AND key_text<\?/.test(plan))).toBe(true)
    expect(plans.some((plan) => /storage_artifacts_pack.*\(namespace=\?\)/.test(plan))).toBe(false)
    expect((await tx.artifactGarbage()).map((entry) => entry.used)).toEqual([false, false])
    database.run("COMMIT")
  } finally {
    tx.finish()
    database.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const format of [2, 3]) {
  test(`format ${format} artifact subtree work seeks within its key range before limits and deletion`, async () => {
    const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "artifact-range-"))
    const filename = path.join(root, "records.sqlite")
    const namespace = "artifact-range"
    if (format === 2) createV2Store({ filename, namespace, records: [] })
    const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace })
    await store.close()
    const database = new Database(filename)
    const plans: string[] = []
    const pageSizes: number[] = []
    let observing = false
    const connection: SqlConnection = {
      async query<Row extends SqlRow>(statement: string, values: SqlValue[] = []) {
        if (observing && /(?:FROM|JOIN) storage_artifacts\b/.test(statement)) {
          const plan = database.query<{ detail: string }, SqlValue[]>("EXPLAIN QUERY PLAN " + statement)
          try {
            plans.push(...plan.all(...values).map((row) => row.detail))
          } finally {
            plan.finalize()
          }
        }
        const query = database.query<Row, SqlValue[]>(statement)
        try {
          const rows = query.all(...values)
          if (observing && statement.includes("SELECT key_text")) pageSizes.push(rows.length)
          return rows
        } finally {
          query.finalize()
        }
      },
    }
    const tx = new StoreTransaction(connection, namespace, false, format === 2 ? "hex" : "bytes")
    const owner = ["sessions", "scope", "session"]
    const prefix = [...owner, "part-content", "selected"]
    const location = {
      pack: "00000000-0000-0000-0000-000000000000.pack",
      codec: "raw" as const,
      blockOffset: 0,
      blockBytes: 1,
      decodedBytes: 1,
      offset: 0,
      size: 1,
      sha256: "0".repeat(64),
    }
    async function observe(body: () => Promise<unknown>) {
      plans.length = 0
      pageSizes.length = 0
      observing = true
      try {
        await body()
      } finally {
        observing = false
      }
      const reads = plans.filter((detail) => /(?:SEARCH|SCAN) storage_artifacts\b/.test(detail))
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((detail) => /namespace=\? AND key_text>\? AND key_text<\?/.test(detail))).toBe(true)
      expect(plans.some((detail) => /USE TEMP B-TREE/.test(detail))).toBe(false)
    }
    try {
      database.run("BEGIN")
      const selected = [prefix, ...Array.from({ length: 600 }, (_, n) => [...prefix, String(n).padStart(4, "0")])]
      await tx.writeArtifacts([
        ...Array.from({ length: 5000 }, (_, n) => ({
          key: [...owner, "part-content", `${n % 2 ? "before" : "unrelated"}-${n}`],
          location,
        })),
        ...selected.map((key) => ({ key, location })),
      ])
      await observe(async () => {
        const found = await Array.fromAsync(tx.artifacts(prefix))
        expect(found.map((row) => JSON.stringify(row.key))).toEqual(selected.map((key) => JSON.stringify(key)).sort())
      })
      expect(pageSizes).toEqual([256, 256, 89, 0])
      await observe(async () => {
        expect(await tx.pruneDeferral(prefix, { nodes: 100, records: 100, artifacts: 4 }, Date.now() + 60_000)).toBe(
          "artifacts",
        )
      })
      expect(pageSizes).toEqual([5])
      await observe(() => tx.removeTree([...prefix, "0003"]))
      expect(await Array.fromAsync(tx.artifacts(prefix))).toHaveLength(600)
      await tx.writeArtifacts([{ key: [...prefix, "0003"], location }])
      const missing = [...owner, "part-content", "missing"]
      await observe(async () => expect(await Array.fromAsync(tx.artifacts(missing))).toEqual([]))
      await observe(async () => {
        expect(
          await tx.pruneDeferral(missing, { nodes: 100, records: 100, artifacts: 4 }, Date.now() + 60_000),
        ).toBeUndefined()
      })
      await observe(() => tx.removeTree(missing))
      await observe(() => tx.pruneTree(missing))
      await observe(() => tx.removeTree(prefix))
      expect(await Array.fromAsync(tx.artifacts(owner))).toHaveLength(5000)
      await tx.writeArtifacts(selected.map((key) => ({ key, location })))
      await observe(() => tx.pruneTree(prefix))
      expect(await Array.fromAsync(tx.artifacts(owner))).toHaveLength(5000)
      database.run("COMMIT")
    } finally {
      tx.finish()
      database.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
