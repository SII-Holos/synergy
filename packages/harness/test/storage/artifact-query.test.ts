import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import type { SqlConnection, SqlRow, SqlValue } from "../../src/storage/sql-contract"
import { StoreTransaction, TransactionalStore } from "../../src/storage/transactional-store"

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
    expect(plans.some((plan) => /namespace=\? AND owner_key=\?/.test(plan))).toBe(true)
    expect(plans.some((plan) => /storage_artifacts_pack.*\(namespace=\?\)/.test(plan))).toBe(false)
    expect((await tx.artifactGarbage()).map((entry) => entry.used)).toEqual([false, false])
    database.run("COMMIT")
  } finally {
    tx.finish()
    database.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(!process.env.SYNERGY_TEST_POSTGRES_URL)(
  "PostgreSQL replacement deduplicates old shared packs",
  async () => {
    const store = await TransactionalStore.open({
      backend: "postgres",
      namespace: crypto.randomUUID(),
      url: process.env.SYNERGY_TEST_POSTGRES_URL!,
    })
    try {
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
      await store.transaction(async (tx) => {
        const entries = Array.from({ length: 128 }, (_, n) => ({ key: ["blobs", String(n)], location }))
        await tx.writeArtifacts(entries)
        const replacement = { ...location, pack: crypto.randomUUID() + ".pack" }
        await tx.writeArtifacts(entries.map((entry) => ({ ...entry, location: replacement })))
        expect(await tx.artifactGarbage()).toEqual([{ pack: location.pack, used: false }])
        await tx.removeTree(["blobs"])
        expect((await tx.artifactGarbage()).map((entry) => entry.used)).toEqual([false, false])
      })
    } finally {
      await store.close()
    }
  },
)
