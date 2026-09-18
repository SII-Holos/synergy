import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"
import { TransactionalStore } from "../../src/storage/transactional-store"

function id(key: string[]) {
  return createHash("sha256").update(JSON.stringify(key)).digest("hex")
}

test("version 1 SQL upgrades preserve plain bodies, revisions and deleted-owner fences", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "sql-format-"))
  const filename = path.join(root, "agent.sqlite")
  initializeSqliteEngine()
  const database = new Database(filename, { create: true })
  const key = ["notes", "historical"]
  const value = { text: "historical evidence".repeat(500), future: { untouched: true } }
  try {
    database.exec(await Bun.file(new URL("./fixtures/agent-v1.sql", import.meta.url)).text())
    database.query("INSERT INTO storage_namespaces(namespace,version,owner,state) VALUES ('old',1,'','idle')").run()
    for (const [key, body, revision] of [
      [["notes", "historical"], JSON.stringify(value), 7],
      [["sessions", "scope", "deleted", "info"], null, 9],
    ] as const) {
      for (let depth = 1; depth <= key.length; depth++) {
        const prefix = [...key.slice(0, depth)]
        database
          .query("INSERT INTO storage_nodes(namespace,key_id,parent_id,key_text,segment) VALUES ('old',?,?,?,?)")
          .run(id(prefix), id(prefix.slice(0, -1)), JSON.stringify(prefix), prefix.at(-1)!)
      }
      database
        .query("INSERT INTO storage_records VALUES ('old',?,?,?,?,?,?,?,?,?,?)")
        .run(id([...key]), JSON.stringify(key), body, revision, key[0], "", "", "", key.at(-1)!, 1)
    }
  } finally {
    database.close()
  }
  try {
    const failure = await TransactionalStore.open({
      backend: "sqlite",
      filename,
      namespace: "old",
      readonly: true,
    }).then(
      async (store) => {
        await store.close()
        return undefined
      },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ name: "StorageIntegrityError" })
    const store = await TransactionalStore.open({ backend: "sqlite", filename, namespace: "old" })
    try {
      expect(await store.versioned<typeof value>(key)).toEqual({ key, value, revision: 7n })
      await store.write(key, value)
      expect((await store.versioned(key)).revision).toBe(8n)
      await expect(store.write(["sessions", "scope", "deleted", "rollout", "event"], {})).rejects.toThrow("deleted")
      expect((await store.verify()).issues).toEqual([])
    } finally {
      await store.close()
    }
    const upgraded = new Database(filename, { readonly: true })
    try {
      expect(upgraded.query<{ version: number }, []>("SELECT version FROM storage_namespaces").get()?.version).toBe(2)
      const body = upgraded
        .query<{ body: string }, []>("SELECT body FROM storage_records WHERE body IS NOT NULL")
        .get()!.body
      expect(Buffer.byteLength(body)).toBeLessThan(Buffer.byteLength(JSON.stringify(value)) / 2)
    } finally {
      upgraded.close()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
