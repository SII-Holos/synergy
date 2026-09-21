import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { keyBytes } from "../../src/storage/transactional-store"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { StorageReclamation } from "../../src/storage/format-reclamation"
import { createV2Store, inspect, keyHex, compressible } from "./format-v3-fixture"

const NAMESPACE = "formatv3"

async function root(label: string) {
  return fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, `${label}-`))
}

/**
 * The shapes both a migrated and a native format 3 store must agree on. Captured
 * through the public store surface so a comparison covers traversal, ordered
 * reads and portable export rather than table contents.
 */
async function observe(store: TransactionalStore) {
  return {
    scanRoots: await store.scan([]),
    sessionTree: await store.scan(["sessions"]),
    sessions: await store.list(["sessions"]),
    records: await store.query({ limit: 1000 }),
    keys: await store.snapshot((tx) => tx.queryKeys({ limit: 1000 })),
    exported: await store.snapshot(async (tx) => {
      const entries: string[] = []
      for await (const entry of tx.exportEntries()) entries.push(JSON.stringify(entry))
      return entries
    }),
  }
}

/**
 * The store's own on-disk size, and how many pages it is still holding free.
 *
 * `page_size * page_count` is the database file itself; the WAL is a journal
 * rather than stored data and is measured separately. This is the figure the
 * rewrite's reclaim phase exists to move, and the one a purely logical
 * comparison cannot see.
 */
function databaseFootprint(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    // Each pragma reports one column named after the pragma itself.
    const read = (pragma: "page_size" | "page_count" | "freelist_count") =>
      Number(database.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get()![pragma])
    const pageSize = read("page_size")
    const pageCount = read("page_count")
    return {
      pageSize,
      pageCount,
      freelistPages: read("freelist_count"),
      databaseBytes: pageSize * pageCount,
    }
  } finally {
    database.close()
  }
}

/**
 * Every byte the store occupies, journal included, at a settled checkpoint.
 *
 * The copy phases write a second copy of every table through the WAL, so a total
 * taken while that journal is still outstanding counts those pages twice and
 * measures how much journal happened to be live rather than what the store
 * stores. Checkpointing first is the same normalization the maintenance path
 * performs before it compares a footprint, and it is what makes the pre- and
 * post-rewrite figures comparable.
 */
async function settledFootprint(filename: string) {
  const database = new Database(filename, { strict: true })
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    database.close()
  }
  let total = 0
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += (await fs.stat(`${filename}${suffix}`)).size
    } catch {
      // A sidecar that does not exist contributes nothing.
    }
  }
  return total
}

/**
 * A rollout-shaped store large enough that the rewrite is worth reclaiming.
 *
 * This is the shape of a real store -- many small rollout records under a few
 * sessions -- and it is sized so the rewrite frees a large share of the file:
 * the byte-keyed tables and the narrower node rows replace far more bytes than
 * they occupy. It is deliberately not larger, because `verify()` scans every
 * node and its cost grows faster than the record count. The reclaim loop's
 * multi-chunk path is exercised at store scale rather than here, where one
 * bounded call already drains the fixture's freelist.
 */
function reclaimRecords(sessions = 100, runs = 30) {
  const records: Array<{ key: string[]; body: string }> = []
  for (let session = 0; session < sessions; session++) {
    const id = `ses_${String(session).padStart(4, "0")}`
    const scope = `scope_${session % 4}`
    records.push({ key: ["sessions", scope, id, "info"], body: JSON.stringify({ id }) })
    for (let run = 0; run < runs; run++)
      records.push({
        key: ["sessions", scope, id, "rollout", "runs", `run_${String(run).padStart(3, "0")}`, "info"],
        body: JSON.stringify({ run, text: "durable rollout evidence ".repeat(12) }),
      })
  }
  return records
}

function fixtureRecords() {
  return [
    { key: ["sessions", "scope_a", "ses_one", "info"], body: JSON.stringify({ id: "ses_one" }) },
    { key: ["sessions", "scope_a", "ses_one", "messages", "msg_one", "info"], body: JSON.stringify({ id: "msg_one" }) },
    {
      key: ["sessions", "scope_a", "ses_one", "messages", "msg_one", "parts", "part_one"],
      body: JSON.stringify({ id: "part_one" }),
    },
    { key: ["sessions", "scope_a", "ses_two", "info"], body: JSON.stringify({ id: "ses_two" }) },
    { key: ["notes", "alpha", "one"], body: JSON.stringify({ text: "alpha" }) },
    { key: ["notes", "alpha", "two"], body: compressible() },
    { key: ["notes", "beta", "one"], body: JSON.stringify({ text: "beta" }) },
    // Tombstones: the deletion fence `remove`/`removeTree` leave behind.
    { key: ["notes", "gone", "leaf"], body: null },
    { key: ["notes", "alpha", "deleted"], body: null },
  ]
}

test("migration-resumable: every phase boundary converges to the uninterrupted result", async () => {
  const baseline = await root("v3-baseline")
  const baselineFile = path.join(baseline, "agent.sqlite")
  createV2Store({ filename: baselineFile, namespace: NAMESPACE, records: fixtureRecords() })
  const reference = await TransactionalStore.open({
    backend: "sqlite",
    namespace: NAMESPACE,
    filename: baselineFile,
  })
  let expected: Awaited<ReturnType<typeof observe>>
  try {
    await StorageFormatV3Migration.run({ store: reference })
    expected = await observe(reference)
  } finally {
    await reference.close()
    await fs.rm(baseline, { recursive: true, force: true })
  }

  // One cut per phase number the migration reports. Throwing inside the callback
  // aborts the run exactly where that phase first makes progress, and the durable
  // state row is whatever the last completed phase wrote -- so every case below
  // resumes from a different point in the state machine.
  for (const cut of [1, 2, 3, 4]) {
    const dir = await root(`v3-cut-${cut}`)
    const filename = path.join(dir, "agent.sqlite")
    createV2Store({ filename, namespace: NAMESPACE, records: fixtureRecords() })
    const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
    try {
      let interrupted = false
      await expect(
        StorageFormatV3Migration.run({
          store,
          progress: (_current, _total, phase) => {
            if (!interrupted && phase === cut) {
              interrupted = true
              throw new Error(`interrupt-at-${cut}`)
            }
          },
        }),
      ).rejects.toThrow(`interrupt-at-${cut}`)
      expect(interrupted).toBe(true)
      // Re-running must complete the rewrite rather than repeat or skip work.
      await StorageFormatV3Migration.run({ store })
      // A third run is a no-op: the terminal phase is durable.
      await StorageFormatV3Migration.run({ store })
      expect(await observe(store)).toEqual(expected)
      const view = inspect(filename, NAMESPACE)
      try {
        expect(view.version()).toBe(3)
        expect(view.keyColumn()).toBe("blob")
      } finally {
        view.close()
      }
    } finally {
      await store.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
})

test("migration-upgrade-and-fresh: a native store and a migrated store behave identically", async () => {
  const cases: Array<{ label: string; records: ReturnType<typeof fixtureRecords> }> = [
    { label: "records", records: fixtureRecords() },
    // An empty namespace and one holding nothing but tombstones are the two
    // degenerate shapes the rewrite must not special-case into a difference.
    { label: "empty", records: [] },
    { label: "tombstones", records: [{ key: ["notes", "gone"], body: null }] },
  ]
  for (const { label, records } of cases) {
    const migratedDir = await root(`v3-migrated-${label}`)
    const nativeDir = await root(`v3-native-${label}`)
    const migratedFile = path.join(migratedDir, "agent.sqlite")
    const nativeFile = path.join(nativeDir, "agent.sqlite")
    createV2Store({ filename: migratedFile, namespace: NAMESPACE, records })
    const migrated = await TransactionalStore.open({
      backend: "sqlite",
      namespace: NAMESPACE,
      filename: migratedFile,
    })
    // A fresh namespace is created directly at format 3 by the open path.
    const native = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename: nativeFile })
    try {
      await StorageFormatV3Migration.run({ store: migrated })
      // Seeding the native store after creation proves the same values are read
      // back from a table that was never in the older format.
      await native.transaction(async (tx) => {
        await tx.writeMany(
          records
            .filter((record) => record.body !== null)
            .map((record) => ({ key: record.key, value: JSON.parse(record.body!) })),
        )
        for (const record of records.filter((entry) => entry.body === null))
          await tx.write(record.key, { placeholder: true })
      })
      await native.transaction(async (tx) => {
        for (const record of records.filter((entry) => entry.body === null)) await tx.remove(record.key)
      })

      expect(await observe(migrated)).toEqual(await observe(native))
      expect(await migrated.verify()).toMatchObject({
        records: records.filter((r) => r.body !== null).length,
        issues: [],
      })
      expect(await native.verify()).toMatchObject({
        records: records.filter((r) => r.body !== null).length,
        issues: [],
      })
      for (const file of [migratedFile, nativeFile]) {
        const view = inspect(file, NAMESPACE)
        try {
          expect(view.version()).toBe(3)
          if (records.some((record) => record.body !== null)) expect(view.keyColumn()).toBe("blob")
        } finally {
          view.close()
        }
      }
    } finally {
      await migrated.close()
      await native.close()
      await fs.rm(migratedDir, { recursive: true, force: true })
      await fs.rm(nativeDir, { recursive: true, force: true })
    }
  }
})

test("traversal-equivalence: scan, list, query and export are unchanged by the rewrite", async () => {
  const dir = await root("v3-traversal")
  const filename = path.join(dir, "agent.sqlite")
  createV2Store({ filename, namespace: NAMESPACE, records: fixtureRecords() })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    const before = await observe(store)
    // A rewrite that changed any recorded value, order or key would show here.
    expect(before.sessions).toHaveLength(4)
    expect(before.scanRoots).toEqual(["notes", "sessions"])
    await StorageFormatV3Migration.run({ store })
    expect(await observe(store)).toEqual(before)
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("key-bytes-identity: the stored key column is the sha256 of the key JSON", async () => {
  const dir = await root("v3-keys")
  const filename = path.join(dir, "agent.sqlite")
  const records = fixtureRecords()
  const preMigration = [{ key: ["pre", "migration", "record"], body: JSON.stringify({ survived: true }) }]
  createV2Store({ filename, namespace: NAMESPACE, records: [...records, ...preMigration] })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    // A record written before the rewrite is readable after it, which is what
    // proves the hex-to-byte conversion addressed the same records.
    await StorageFormatV3Migration.run({ store })
    expect(await store.read<{ survived: boolean }>(["pre", "migration", "record"])).toEqual({ survived: true })
    const view = inspect(filename, NAMESPACE)
    try {
      for (const row of view.recordKeys()) {
        const key = JSON.parse(row.key_text) as string[]
        expect(row.key_id).toBeInstanceOf(Uint8Array)
        expect(Buffer.from(row.key_id as Uint8Array).toString("hex")).toBe(keyHex(key))
        expect(Array.from(row.key_id as Uint8Array)).toEqual(Array.from(keyBytes(key)))
      }
      expect(view.recordKeys().length).toBeGreaterThan(0)
    } finally {
      view.close()
    }
    // Each node row is addressed by the digest of the prefix it names, and its
    // parent by the digest of that prefix's parent -- the chain `scan`/`list`
    // walk after the rewrite.
    const database = new Database(filename, { readonly: true })
    try {
      const query = database.query<{ parent_id: Uint8Array; segment: string }, [string, Uint8Array]>(
        "SELECT parent_id, segment FROM storage_nodes WHERE namespace = ? AND key_id = ?",
      )
      for (const prefix of [["pre"], ["pre", "migration"], ["pre", "migration", "record"]]) {
        const node = query.get(NAMESPACE, keyBytes(prefix))!
        expect(node.segment).toBe(prefix.at(-1)!)
        expect(Array.from(node.parent_id)).toEqual(Array.from(keyBytes(prefix.slice(0, -1))))
      }
      query.finalize()
    } finally {
      database.close()
    }
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("reclaim-footprint: independent reclamation returns the pages freed by a committed rewrite", async () => {
  const dir = await root("v3-footprint")
  const filename = path.join(dir, "agent.sqlite")
  // A store whose record table dwarfs its journal, so the footprint comparison
  // below measures the rewrite rather than how much of the WAL happened to be
  // outstanding when it was taken.
  createV2Store({ filename, namespace: NAMESPACE, records: reclaimRecords(), incrementalVacuum: true })
  const before = databaseFootprint(filename)
  const beforeTotal = await settledFootprint(filename)
  expect(before.freelistPages).toBe(0)

  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    await StorageFormatV3Migration.run({ store })
    await StorageReclamation.drain(store)
  } finally {
    await store.close()
  }

  const after = databaseFootprint(filename)
  const afterTotal = await settledFootprint(filename)
  // The rewrite drops three tables that together held every byte it rewrote, so
  // finishing with a larger file means those pages were never returned. This is
  // the assertion the logical-equality tests above cannot make: they compare what
  // the store reads back, not what it occupies.
  expect(after.freelistPages).toBe(0)
  expect(after.databaseBytes).toBeLessThan(before.databaseBytes)
  expect(afterTotal).toBeLessThan(beforeTotal)
  // The reclaim is a structural change, not a marginal one: the byte-keyed tables
  // and the narrower node rows are far smaller than what they replace.
  expect(after.databaseBytes).toBeLessThan(before.databaseBytes * 0.75)
  // The rewrite must leave the namespace readable and current, not merely small.
  const view = inspect(filename, NAMESPACE)
  try {
    expect(view.version()).toBe(3)
    expect(view.keyColumn()).toBe("blob")
  } finally {
    view.close()
  }
  const reopened = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    expect((await reopened.verify()).issues).toEqual([])
  } finally {
    await reopened.close()
  }
  await fs.rm(dir, { recursive: true, force: true })
}, 30_000)

test("reclaim-resumes: an interrupted reclaim continues from the swap instead of repeating the rewrite", async () => {
  const dir = await root("v3-reclaim-resume")
  const filename = path.join(dir, "agent.sqlite")
  createV2Store({ filename, namespace: NAMESPACE, records: reclaimRecords(), incrementalVacuum: true })
  const before = databaseFootprint(filename)
  let store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    await StorageFormatV3Migration.run({ store })
    const midway = databaseFootprint(filename)
    expect(midway.freelistPages).toBeGreaterThan(0)

    await expect(
      StorageReclamation.drain(store, {
        progress: (current) => {
          if (current > 0) throw new Error("interrupted after a reclaim checkpoint")
        },
      }),
    ).rejects.toThrow("interrupted after a reclaim checkpoint")
    await store.close()
    store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })

    // The resumed run reports only the reclaim phase, so it cannot have repeated
    // the copy phases, and it converges the freelist to empty.
    const phases: number[] = []
    await StorageReclamation.drain(store, { progress: (_current, _total, phase) => phases.push(phase) })
    expect([...new Set(phases)]).toEqual([5])
    const reclaimed = databaseFootprint(filename)
    expect(reclaimed.freelistPages).toBe(0)
    expect(reclaimed.databaseBytes).toBeLessThan(before.databaseBytes)
    expect(reclaimed.databaseBytes).toBeLessThan(midway.pageCount * midway.pageSize)

    // A completed migration is a no-op: no phase reports and no byte moves.
    const settled = await settledFootprint(filename)
    const settledDatabase = databaseFootprint(filename)
    const idle: number[] = []
    await StorageFormatV3Migration.run({ store, progress: (_current, _total, phase) => idle.push(phase) })
    expect(idle).toEqual([])
    expect(databaseFootprint(filename)).toEqual(settledDatabase)
    expect(await settledFootprint(filename)).toBe(settled)
    expect((await store.verify()).issues).toEqual([])
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 30_000)

test("reclaim-bounded: a store that cannot reclaim terminates and reports instead of spinning", async () => {
  const dir = await root("v3-reclaim-stalled")
  const filename = path.join(dir, "agent.sqlite")
  // Auto-vacuum off, which is the mode where `PRAGMA incremental_vacuum` is a
  // silent no-op: it neither returns pages nor raises, so a freelist-driven loop
  // would never terminate.
  createV2Store({ filename, namespace: NAMESPACE, records: reclaimRecords(20, 10), incrementalVacuum: false })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  try {
    // A hang here is the defect: this must terminate on its own.
    await StorageFormatV3Migration.run({ store })
    const result = await StorageReclamation.drain(store)
    const stalled = databaseFootprint(filename)
    expect(stalled.freelistPages).toBeGreaterThan(0)
    // The format is still committed and readable; only the pages are unreturned.
    expect((await store.verify()).issues).toEqual([])
    expect(result.reclaim.pending).toBe(true)
    expect(result.reclaim.error).toContain("explicit maintenance window")
    // The phase stays unclaimed, so a re-run resumes rather than marks it done.
    const resumed = databaseFootprint(filename)
    await StorageFormatV3Migration.run({ store })
    expect(databaseFootprint(filename).pageCount).toBe(resumed.pageCount)
    expect((await store.verify()).issues).toEqual([])
  } finally {
    await store.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
