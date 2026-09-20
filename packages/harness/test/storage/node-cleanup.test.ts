import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore, keyBytes } from "../../src/storage/transactional-store"
import { createV2Store, keyHex } from "./format-v3-fixture"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"

// `setCustomSQLite` only works before SQLite auto-loads, and several tests here
// open a `Database` directly, so the engine must be selected first.
initializeSqliteEngine()

const NAMESPACE = "node-cleanup"
const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "node-cleanup-"))
const stores: TransactionalStore[] = []

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()))
  await fs.rm(root, { recursive: true, force: true })
})

async function open(label: string) {
  const filename = path.join(root, `${label}.sqlite`)
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  stores.push(store)
  return { store, filename }
}

const session = (id: string) => ({ key: ["sessions", "scope", id, "info"], value: { id } })
const message = (id: string, messageID: string) => ({
  key: ["sessions", "scope", id, "messages", messageID, "info"],
  value: { id: messageID },
})

/**
 * Reads the tables directly, because neither row class is visible through the
 * query surface: a node row a removal emptied is not returned by `scan`/`list`,
 * and a tombstone is not returned by `read`.
 */
function inspect(filename: string) {
  const database = new Database(filename, { readonly: true })
  const count = (statement: string) => Number((database.query(statement).get(NAMESPACE) as { c: number | bigint }).c)
  const present = (statement: string, key: string[]) => database.query(statement).get(NAMESPACE, keyBytes(key)) !== null
  return {
    nodeExists: (key: string[]) => present("SELECT 1 FROM storage_nodes WHERE namespace = ? AND key_id = ?", key),
    recordExists: (key: string[]) => present("SELECT 1 FROM storage_records WHERE namespace = ? AND key_id = ?", key),
    nodeCount: () => count("SELECT COUNT(*) c FROM storage_nodes WHERE namespace = ?"),
    tombstoneCount: () => count("SELECT COUNT(*) c FROM storage_records WHERE namespace = ? AND body IS NULL"),
    liveCount: () => count("SELECT COUNT(*) c FROM storage_records WHERE namespace = ? AND body IS NOT NULL"),
    close: () => database.close(),
  }
}

test("removeTree drops the subtree's nodes, keeps every tombstone, and fences a delayed writer", async () => {
  const { store, filename } = await open("remove-tree")
  const live = [
    ["sessions", "scope", "other", "info"],
    ["sessions", "scope", "other", "messages", "m2", "info"],
  ]
  await store.transaction((tx) =>
    tx.writeMany([
      session("ses"),
      message("ses", "msg"),
      { key: ["sessions", "scope", "ses", "messages", "msg", "parts", "p1"], value: { id: "p1" } },
      session("other"),
      message("other", "m2"),
    ]),
  )

  await store.removeTree(["sessions", "scope", "ses"])

  // Traversal drops the removed session and keeps the live sibling.
  expect(await store.scan(["sessions", "scope"])).toEqual(["other"])
  expect(await store.list(["sessions"])).toEqual(live)
  // The fence is the session owner row: it is tombstoned, so a delayed writer
  // issuing new work anywhere under that session is still refused.
  await expect(store.transaction((tx) => tx.writeMany([message("ses", "m9")]))).rejects.toThrow(
    "A deleted record cannot be revived by a delayed writer",
  )
  expect((await store.verify()).issues).toEqual([])
  await store.close()

  const check = inspect(filename)
  try {
    // Every node below the removed session lost its only live record, so the
    // chain drains from the leaves up.
    for (const key of [
      ["sessions", "scope", "ses"],
      ["sessions", "scope", "ses", "info"],
      ["sessions", "scope", "ses", "messages"],
      ["sessions", "scope", "ses", "messages", "msg"],
      ["sessions", "scope", "ses", "messages", "msg", "info"],
      ["sessions", "scope", "ses", "messages", "msg", "parts"],
      ["sessions", "scope", "ses", "messages", "msg", "parts", "p1"],
    ])
      expect(check.nodeExists(key)).toBe(false)
    // The two shared prefix nodes and the live sibling's own chain remain.
    for (const key of [
      ["sessions"],
      ["sessions", "scope"],
      ["sessions", "scope", "other"],
      ["sessions", "scope", "other", "info"],
      ["sessions", "scope", "other", "messages"],
      ["sessions", "scope", "other", "messages", "m2"],
      ["sessions", "scope", "other", "messages", "m2", "info"],
    ])
      expect(check.nodeExists(key)).toBe(true)
    expect(check.nodeCount()).toBe(7)
    // Every removed record keeps its row; only its node was cleaned.
    for (const key of [
      ["sessions", "scope", "ses", "info"],
      ["sessions", "scope", "ses", "messages", "msg", "info"],
      ["sessions", "scope", "ses", "messages", "msg", "parts", "p1"],
    ])
      expect(check.recordExists(key)).toBe(true)
    expect(check.tombstoneCount()).toBe(3)
    expect(check.liveCount()).toBe(2)
  } finally {
    check.close()
  }
})

test("remove drains the chain it emptied and never drops a shared ancestor", async () => {
  const { store, filename } = await open("remove-single")
  const sibling = ["sessions", "scope", "other", "info"]
  await store.transaction((tx) => tx.writeMany([session("ses"), message("ses", "msg"), session("other")]))

  await store.remove(["sessions", "scope", "ses", "info"])
  await store.remove(["sessions", "scope", "ses", "messages", "msg", "info"])

  // Removing the session owner tombstones the fence, so the delayed writer is
  // refused before it can reach the store.
  await expect(store.transaction((tx) => tx.writeMany([message("ses", "m2")]))).rejects.toThrow(
    "A deleted record cannot be revived by a delayed writer",
  )
  expect((await store.verify()).issues).toEqual([])
  await store.close()

  const check = inspect(filename)
  try {
    // With both records tombstoned, `messages`, its message node and the session
    // node above them all lose their last live record or child and drain.
    for (const key of [
      ["sessions", "scope", "ses"],
      ["sessions", "scope", "ses", "info"],
      ["sessions", "scope", "ses", "messages"],
      ["sessions", "scope", "ses", "messages", "msg"],
      ["sessions", "scope", "ses", "messages", "msg", "info"],
    ])
      expect(check.nodeExists(key)).toBe(false)
    // `scope` and the root still carry the live sibling branch, so they stay.
    for (const key of [["sessions"], ["sessions", "scope"], sibling]) expect(check.nodeExists(key)).toBe(true)
    expect(check.nodeCount()).toBe(4)
    expect(check.tombstoneCount()).toBe(2)
    expect(check.liveCount()).toBe(1)
  } finally {
    check.close()
  }
})

test("a removed non-session key drops its node while its record row survives", async () => {
  const { store, filename } = await open("remove-tombstone")
  const removed = ["a", "b", "c"]
  await store.write(["a", "other"], { value: 1 })
  await store.write(removed, { value: 2 })

  await store.remove(removed)

  expect(await store.scan(["a"])).toEqual(["other"])
  expect(await store.read<{ value: number }>(["a", "other"])).toEqual({ value: 1 })
  expect((await store.verify()).issues).toEqual([])
  await store.close()

  const check = inspect(filename)
  try {
    // `a/b` held only the removed key, so it drains; `a` still carries `a/other`.
    expect(check.nodeExists(removed)).toBe(false)
    expect(check.nodeExists(["a", "b"])).toBe(false)
    expect(check.nodeExists(["a"])).toBe(true)
    expect(check.nodeExists(["a", "other"])).toBe(true)
    expect(check.recordExists(removed)).toBe(true)
    expect(check.nodeCount()).toBe(2)
  } finally {
    check.close()
  }
})

test("node cleanup reaches a fixed point on a chain deeper than one round can free", async () => {
  const { store, filename } = await open("deep-chain")
  const chain: string[][] = [["chain"]]
  for (let depth = 0; depth < 80; depth++) chain.push([...chain.at(-1)!, `l${depth}`])
  await store.transaction((tx) => tx.writeMany(chain.map((key, index) => ({ key, value: { index } }))))
  expect((await store.verify()).issues).toEqual([])

  await store.removeTree(["chain"])

  // A round frees only the current leaf, so a capped loop would leave interior
  // nodes that `verify` reports as `node_without_record`. Reaching a fixed point
  // is what makes the assertion below hold for a chain this deep.
  expect((await store.verify()).issues).toEqual([])
  expect(await store.scan([])).toEqual([])
  await store.close()

  const check = inspect(filename)
  try {
    expect(check.nodeCount()).toBe(0)
    expect(check.liveCount()).toBe(0)
    expect(check.tombstoneCount()).toBe(chain.length)
  } finally {
    check.close()
  }
})

test("removeTree of the whole namespace tombstones every record and drains every node", async () => {
  const { store, filename } = await open("whole-namespace")
  const entries = [
    session("ses"),
    message("ses", "msg"),
    { key: ["notes", "kept", "leaf"], value: { kept: true } },
    { key: ["projects", "proj", "config"], value: { config: true } },
  ]
  await store.transaction((tx) => tx.writeMany(entries))
  expect((await store.verify()).issues).toEqual([])

  await store.removeTree([])

  // Every subtree is gone from traversal and nothing is left for `verify` to
  // call an orphan, which is the empty-prefix branch's own cleanup call.
  expect(await store.scan([])).toEqual([])
  expect((await store.verify()).issues).toEqual([])
  await store.close()

  const check = inspect(filename)
  try {
    expect(check.nodeCount()).toBe(0)
    expect(check.liveCount()).toBe(0)
    // The tombstone is the fence for every removed key, so all record rows stay.
    expect(check.tombstoneCount()).toBe(entries.length)
    for (const { key } of entries) expect(check.recordExists(key)).toBe(true)
  } finally {
    check.close()
  }
})

test("a format 2 namespace cleans its hex node rows without touching the fence", async () => {
  // A production store is format 2 until the v3 rewrite runs, and it binds every
  // key column as hex text rather than as a byte digest. The cleanup has to follow
  // the namespace's own encoding, or it would address no row at all.
  const filename = path.join(root, "v2-namespace.sqlite")
  createV2Store({
    filename,
    namespace: NAMESPACE,
    records: [
      { key: ["sessions", "scope", "ses", "info"], body: JSON.stringify({ id: "ses" }) },
      { key: ["sessions", "scope", "ses", "messages", "msg", "info"], body: JSON.stringify({ id: "msg" }) },
      { key: ["sessions", "scope", "other", "info"], body: JSON.stringify({ id: "other" }) },
    ],
  })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  stores.push(store)
  try {
    // The namespace keeps its recorded version, so it is served with hex keys;
    // the assertions below address the node rows by hex digest, which is what
    // proves the cleanup followed that encoding rather than the byte one.
    const version = new Database(filename, { readonly: true })
    try {
      expect(
        Number(
          (
            version.query("SELECT version FROM storage_namespaces WHERE namespace = ?").get(NAMESPACE) as {
              version: number | bigint
            }
          ).version,
        ),
      ).toBe(2)
    } finally {
      version.close()
    }
    expect((await store.verify()).issues).toEqual([])

    await store.removeTree(["sessions", "scope", "ses"])

    expect(await store.scan(["sessions", "scope"])).toEqual(["other"])
    await expect(
      store.transaction((tx) =>
        tx.writeMany([{ key: ["sessions", "scope", "ses", "messages", "m9", "info"], value: {} }]),
      ),
    ).rejects.toThrow("A deleted record cannot be revived by a delayed writer")
    expect((await store.verify()).issues).toEqual([])
    await store.close()

    const database = new Database(filename, { readonly: true })
    try {
      const count = (statement: string) =>
        Number((database.query(statement).get(NAMESPACE) as { c: number | bigint }).c)
      const nodeExists = (key: string[]) =>
        database.query("SELECT 1 FROM storage_nodes WHERE namespace = ? AND key_id = ?").get(NAMESPACE, keyHex(key)) !==
        null
      // The removed chain is addressed by hex text and drains; the two shared
      // prefix nodes and the live sibling's chain remain.
      for (const key of [
        ["sessions", "scope", "ses"],
        ["sessions", "scope", "ses", "info"],
        ["sessions", "scope", "ses", "messages"],
        ["sessions", "scope", "ses", "messages", "msg"],
        ["sessions", "scope", "ses", "messages", "msg", "info"],
      ])
        expect(nodeExists(key)).toBe(false)
      for (const key of [
        ["sessions"],
        ["sessions", "scope"],
        ["sessions", "scope", "other"],
        ["sessions", "scope", "other", "info"],
      ])
        expect(nodeExists(key)).toBe(true)
      expect(count("SELECT COUNT(*) c FROM storage_nodes WHERE namespace = ?")).toBe(4)
      expect(count("SELECT COUNT(*) c FROM storage_records WHERE namespace = ? AND body IS NULL")).toBe(2)
    } finally {
      database.close()
    }
  } finally {
    await store.close()
  }
})
