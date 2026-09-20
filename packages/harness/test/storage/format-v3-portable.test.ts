import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { StoragePortable } from "../../src/storage/portable"
import { RecordCodec } from "../../src/storage/record-codec"
import { TransactionalStore, keyBytes } from "../../src/storage/transactional-store"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { createV2Store, compressible, legacyBody } from "./format-v3-fixture"

const NAMESPACE = "roundtrip"

async function root(label: string) {
  return fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, `${label}-`))
}

function open(filename: string, namespace = NAMESPACE) {
  return TransactionalStore.open({ backend: "sqlite", namespace, filename })
}

test("export-import-roundtrip: a compressed body survives a portable export and import", async () => {
  const sourceDir = await root("v3-export-source")
  const targetDir = await root("v3-export-target")
  const archive = path.join(sourceDir, "archive.ndjson")
  const source = await open(path.join(sourceDir, "agent.sqlite"))
  const target = await open(path.join(targetDir, "agent.sqlite"))
  try {
    // A body above the compression floor takes the frame branch, so the value the
    // portable envelope must carry is a byte array rather than JSON text.
    const value = { text: "durable rollout evidence ".repeat(200), nested: { unknown: true } }
    expect(RecordCodec.encode(value)).toBeInstanceOf(Uint8Array)
    await source.write(["sessions", "scope", "ses", "info"], { id: "ses" })
    await source.write(["sessions", "scope", "ses", "rollout", "runs", "run_1", "info"], value)
    await source.write(["notes", "small"], { v: 1 })
    await source.write(["notes", "tombstone"], { v: 2 })
    await source.remove(["notes", "tombstone"])

    const report = await StoragePortable.exportFile(source, archive)
    expect(report.count).toBeGreaterThan(0)
    // The envelope is JSON, so a frame must have been encoded into it rather than
    // written as raw bytes; the line must still parse as an entry.
    const text = await Bun.file(archive).text()
    expect(text).toContain('"type":"record"')
    expect(() =>
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).not.toThrow()

    await StoragePortable.importFile(target, archive)
    expect(await target.read<typeof value>(["sessions", "scope", "ses", "rollout", "runs", "run_1", "info"])).toEqual(
      value,
    )
    expect(await target.read<{ v: number }>(["notes", "small"])).toEqual({ v: 1 })
    // A tombstone is not exported, so the imported target has no record for it.
    await expect(target.read(["notes", "tombstone"])).rejects.toThrow("does not exist")
    expect((await target.verify()).issues).toEqual([])
  } finally {
    await source.close()
    await target.close()
    await fs.rm(sourceDir, { recursive: true, force: true })
    await fs.rm(targetDir, { recursive: true, force: true })
  }
})

test("export-import-roundtrip: a migrated store exports and imports both body forms identically", async () => {
  const sourceDir = await root("v3-migrated-export")
  const targetDir = await root("v3-migrated-import")
  const archive = path.join(sourceDir, "archive.ndjson")
  const sourceFile = path.join(sourceDir, "agent.sqlite")
  // One body kept as plain JSON, one stored in the retired base64 form, and one
  // large enough to become a frame after the rewrite.
  createV2Store({
    filename: sourceFile,
    namespace: NAMESPACE,
    records: [
      { key: ["notes", "plain"], body: JSON.stringify({ v: 1 }) },
      { key: ["notes", "legacy"], body: legacyBody({ legacy: "x".repeat(2048) }) },
      { key: ["notes", "compressible"], body: compressible() },
    ],
  })
  const source = await open(sourceFile)
  const target = await open(path.join(targetDir, "agent.sqlite"))
  try {
    await StorageFormatV3Migration.run({ store: source })
    const expected = await source.snapshot(async (tx) => {
      const entries: string[] = []
      for await (const entry of tx.exportEntries()) entries.push(JSON.stringify(entry))
      return entries
    })
    await StoragePortable.exportFile(source, archive)
    await StoragePortable.importFile(target, archive)
    const actual = await target.snapshot(async (tx) => {
      const entries: string[] = []
      for await (const entry of tx.exportEntries()) entries.push(JSON.stringify(entry))
      return entries
    })
    expect(actual).toEqual(expected)
    expect(await target.read<{ v: number }>(["notes", "plain"])).toEqual({ v: 1 })
    expect((await target.verify()).issues).toEqual([])
  } finally {
    await source.close()
    await target.close()
    await fs.rm(sourceDir, { recursive: true, force: true })
    await fs.rm(targetDir, { recursive: true, force: true })
  }
})

test("node-orphan-invariant: verify reports unreachable nodes and a rebuild repairs them", async () => {
  const dir = await root("v3-orphan")
  const filename = path.join(dir, "agent.sqlite")
  const store = await open(filename)
  try {
    await store.transaction(async (tx) => {
      await tx.writeMany([
        { key: ["sessions", "scope", "ses", "info"], value: { id: "ses" } },
        { key: ["sessions", "scope", "ses", "messages", "msg", "info"], value: { id: "msg" } },
        { key: ["notes", "kept", "leaf"], value: { kept: true } },
      ])
    })
    expect((await store.verify()).issues).toEqual([])

    // `removeTree` tombstones the records and keeps that revision fence, but the
    // nodes the fence leaves unreachable are cleaned up in the same transaction,
    // so the subtree leaves no node behind and the store still verifies clean.
    await store.removeTree(["notes", "kept"])
    expect((await store.verify()).issues).toEqual([])

    // An interrupted `pruneTree` deletes records before it deletes nodes, so that
    // stranded state is reproduced by removing the record rows directly. A node
    // with no record row anywhere beneath it is what `verify` reports.
    await store.write(["orphan", "deep", "leaf"], { stranded: true })
    const database = new Database(filename)
    try {
      database.run("DELETE FROM storage_records WHERE namespace = ? AND key_text = ?", [
        NAMESPACE,
        JSON.stringify(["orphan", "deep", "leaf"]),
      ])
    } finally {
      database.close()
    }
    // Removing the only record beneath that path strands the whole chain: the
    // leaf, its parent and the shared root now have no record under them at all.
    const orphans = (await store.verify()).issues
    expect(orphans.map((issue) => issue.key.join("/")).sort()).toEqual(["orphan", "orphan/deep", "orphan/deep/leaf"])
    expect(orphans.every((issue) => issue.reason === "node_without_record")).toBe(true)

    // The rebuild derives nodes from the live records, so it removes the nodes no
    // record reaches -- the `orphan` chain just stranded -- and leaves the
    // reachable ones intact.
    await StorageFormatV3Migration.rebuildNodes(store)
    expect((await store.verify()).issues).toEqual([])
    // No live record remains under `notes` or `orphan`: `removeTree` already
    // cleaned the first and the rebuild removes the second, so only the live
    // session tree is left in the traversal index.
    expect(await store.scan([])).toEqual(["sessions"])
    expect(await store.scan(["notes"])).toEqual([])
    expect(await store.scan(["orphan"])).toEqual([])
    expect(await store.list(["sessions"])).toEqual([
      ["sessions", "scope", "ses", "info"],
      ["sessions", "scope", "ses", "messages", "msg", "info"],
    ])
    // The rebuilt rows are addressed by the same byte digests the live records
    // use, so traversal still joins the two tables.
    const check = new Database(filename, { readonly: true })
    try {
      const query = check.query<{ segment: string }, [string, Uint8Array]>(
        "SELECT segment FROM storage_nodes WHERE namespace = ? AND key_id = ?",
      )
      expect(query.get(NAMESPACE, keyBytes(["sessions"]))?.segment).toBe("sessions")
      // The removed subtree left no node for a later write to collide with, and
      // the rebuild did not resurrect the stranded chain.
      expect(query.get(NAMESPACE, keyBytes(["notes"]))).toBeNull()
      expect(query.get(NAMESPACE, keyBytes(["notes", "kept"]))).toBeNull()
      expect(query.get(NAMESPACE, keyBytes(["orphan"]))).toBeNull()
      query.finalize()
    } finally {
      check.close()
    }
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("node-orphan-invariant: a live record whose node is missing is corruption, not an orphan", async () => {
  const dir = await root("v3-missing-node")
  const filename = path.join(dir, "agent.sqlite")
  const store = await open(filename)
  try {
    await store.write(["notes", "reachable"], { v: 1 })
    const database = new Database(filename)
    try {
      database.run("DELETE FROM storage_nodes WHERE namespace = ? AND key_id = ?", [
        NAMESPACE,
        keyBytes(["notes", "reachable"]),
      ])
    } finally {
      database.close()
    }
    // A record the index cannot address is unreachable by traversal while the
    // record page still returns it, which must stop verification rather than be
    // reported as a countable issue.
    await expect(store.verify()).rejects.toThrow("Logical storage index integrity verification failed")
    await StorageFormatV3Migration.rebuildNodes(store)
    expect((await store.verify()).issues).toEqual([])
    expect(await store.read<{ v: number }>(["notes", "reachable"])).toEqual({ v: 1 })
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
