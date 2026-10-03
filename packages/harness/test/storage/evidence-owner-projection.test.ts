import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import type { SqlDriver } from "../../src/storage/sql-contract"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const key = (id: string) => ["sessions", "scope", "session", "rollout", "events", id]

test("background text cleanup progresses after owner preparation takes longer than an admission budget", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "slow-preparation",
      filename: path.join(tmp.path, "agent.sqlite"),
    })
    try {
      const sourceKey = ["sessions", "scope", "session", "messages", "message", "parts", "part"]
      await store.write(sourceKey, { text: "old text" })
      const source = await store.versioned(sourceKey)
      await store.transaction((tx) =>
        tx.appendTextProjection({
          key: sourceKey,
          revision: source.revision,
          version: "v1",
          category: "text",
          offset: 0,
          fragments: [{ offset: 0, text: "old text" }],
          complete: true,
        }),
      )
      await store.write(sourceKey, { text: "new text" })
      const prepare = store.prepareEvidenceOwners.bind(store)
      using delayed = spyOn(store, "prepareEvidenceOwners").mockImplementation(async (input) => {
        await Bun.sleep(150)
        return prepare(input)
      })
      const driver = (store as unknown as { driver: SqlDriver }).driver
      const deadline = Date.now() + 3_000
      let remaining = 1
      while (remaining && Date.now() < deadline) {
        await Bun.sleep(100)
        const [row] = await driver.query("SELECT COUNT(*) AS count FROM storage_text_gc WHERE namespace = ?", [
          store.options.namespace,
        ])
        remaining = Number(row.count)
      }
      expect(delayed).toHaveBeenCalled()
      expect(remaining).toBe(0)
    } finally {
      await store.close()
    }
  }))

test("operation newest removal withholds retention until a bounded recount converges", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "operations",
      filename: path.join(tmp.path, "agent.sqlite"),
    })
    try {
      const first = ["operations", "scope", "operation", "rollout", "a"]
      const latest = ["operations", "scope", "operation", "rollout", "b"]
      await store.write(first, 1)
      await store.write(latest, 2)
      await store.write(latest, 3)
      expect((await store.evidenceOwners())[0]?.records).toBe(2)
      await store.remove(latest)
      expect(await store.evidenceOwners()).toEqual([])
      for (let batch = 0; batch < 10; batch++) if ((await store.prepareEvidenceOwners({ maxRows: 1 })).ready) break
      expect((await store.evidenceOwners())[0]?.records).toBe(1)
    } finally {
      await store.close()
    }
  }))

test("owner projection tracks overwrite, tombstone and physical deletion exactly", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "owners",
      filename: path.join(tmp.path, "agent.sqlite"),
    })
    try {
      await store.transaction((tx) =>
        tx.writeMany([
          { key: key("a"), value: 1 },
          { key: key("b"), value: 2 },
        ]),
      )
      const initial = await store.evidenceOwners()
      expect(initial[0]?.records).toBe(2)
      await store.write(key("a"), 3)
      expect((await store.evidenceOwners())[0]?.records).toBe(2)
      await store.remove(key("b"))
      expect((await store.evidenceOwners())[0]?.records).toBe(1)
      const remaining = await store.evidenceOwners()
      const rows = await (store as unknown as { driver: SqlDriver }).driver.query(
        "SELECT updated FROM storage_records WHERE namespace = ? AND body IS NOT NULL AND kind = 'rollout'",
        ["owners"],
      )
      expect(remaining[0]?.newest).toBe(Number(rows[0]?.updated))
      await store.pruneTree(["sessions", "scope", "session", "rollout"])
      expect(await store.evidenceOwners()).toEqual([])
    } finally {
      await store.close()
    }
  }))

test("historical owner preparation is bounded, resumable, and never admits an unknown count", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    const options = { backend: "sqlite" as const, namespace: "upgrade", filename: path.join(tmp.path, "agent.sqlite") }
    let store = await TransactionalStore.open(options)
    try {
      await store.transaction((tx) =>
        tx.writeMany(Array.from({ length: 9 }, (_, id) => ({ key: key(String(id)), value: id }))),
      )
      const driver = (store as unknown as { driver: SqlDriver }).driver
      await driver.transaction(async (tx) => {
        const triggers = await tx.query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'storage_evidence_%'",
        )
        for (const row of triggers) await tx.query(`DROP TRIGGER ${row.name}`)
        await tx.query("DROP TABLE IF EXISTS storage_evidence_owners")
        await tx.query("DROP TABLE IF EXISTS storage_evidence_preparation")
      })
      await store.close()
      store = await TransactionalStore.open(options)
      expect(await store.evidenceOwners()).toEqual([])
      const progress = await store.prepareEvidenceOwners({ maxRows: 2 })
      expect(progress.scanned).toBeLessThanOrEqual(2)
      expect(progress.ready).toBe(false)
      await store.write(key("0"), "concurrent overwrite")
      await store.remove(key("8"))
      await store.close()
      store = await TransactionalStore.open(options)
      for (let batch = 0; batch < 40; batch++) {
        const progress = await store.prepareEvidenceOwners({ maxRows: 2 })
        expect(progress.scanned).toBeLessThanOrEqual(2)
        if (progress.ready) break
      }
      expect((await store.evidenceOwners())[0]?.records).toBe(8)
      expect(await store.prepareEvidenceOwners({ maxRows: 2 })).toMatchObject({ ready: true, scanned: 0 })
    } finally {
      await store.close()
    }
  }))
