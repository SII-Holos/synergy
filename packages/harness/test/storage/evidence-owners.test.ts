import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StorageRecordsOwnerIndex } from "../../src/storage/owner-index"
import { StoragePath } from "../../src/storage/path"
import { TransactionalStore } from "../../src/storage/transactional-store"

interface Connection {
  query(statement: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>
}

interface DriverInternals extends Connection {
  transaction<T>(body: (connection: Connection) => Promise<T>): Promise<T>
}

interface SeedRow {
  key: string[]
  kind: string
  scopeID: string
  sessionID: string
  updated: number
}

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "evidence-owners-"))
const stores: TransactionalStore[] = []

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()))
  await fs.rm(root, { recursive: true, force: true })
})

async function open(backend: "sqlite" | "postgres" = "sqlite") {
  const namespace = crypto.randomUUID()
  const store = await TransactionalStore.open(
    backend === "sqlite"
      ? { backend, namespace, filename: path.join(root, `${namespace}.sqlite`) }
      : { backend, namespace, url: process.env.SYNERGY_TEST_POSTGRES_URL! },
  )
  stores.push(store)
  return store
}

function driver(store: TransactionalStore) {
  return (store as unknown as { driver: DriverInternals }).driver
}

const COLUMNS =
  "namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated"

/**
 * Writes rows straight into `storage_records` so a test can place owner-column
 * states the write path itself never produces. Production inserts go through
 * `writeMany`; this is fixture setup for the enumeration's edge cases.
 */
async function seed(store: TransactionalStore, rows: SeedRow[]) {
  await driver(store).transaction(async (connection) => {
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200)
      await connection.query(
        `INSERT INTO storage_records(${COLUMNS}) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
        batch.flatMap((row) => [
          store.options.namespace,
          `key_${crypto.randomUUID()}`,
          JSON.stringify(row.key),
          JSON.stringify({ v: 1 }),
          1,
          row.kind,
          row.scopeID,
          row.sessionID,
          "",
          row.key.at(-1)!,
          row.updated,
        ]),
      )
    }
  })
}

/**
 * Rollout owners as the `MIN(key_text)` statement produced them before the owner
 * columns carried the enumeration. Pruning is irreversible, so the indexed form
 * has to agree with this on the owner set, on each owner's newest timestamp, and
 * on its record count.
 */
async function keyTextRolloutOwners(store: TransactionalStore) {
  const rows = await driver(store).query(
    `SELECT MIN(key_text) AS key_text, MAX(updated) AS newest, COUNT(*) AS records FROM storage_records WHERE namespace = ? AND kind = 'rollout' AND body IS NOT NULL GROUP BY scope_id, session_id`,
    [store.options.namespace],
  )
  return rows
    .flatMap((row) => {
      const key = JSON.parse(String(row.key_text)) as string[]
      if (key.length < 4) return []
      return [{ key: key.slice(0, 4).join("/"), newest: Number(row.newest), records: Number(row.records) }]
    })
    .sort((left, right) => left.key.localeCompare(right.key))
}

function sessionOwners(owners: Awaited<ReturnType<TransactionalStore["evidenceOwners"]>>) {
  return owners
    .filter((owner) => owner.kind === "session")
    .map((owner) => ({ key: owner.keyPrefix.join("/"), newest: owner.newest, records: owner.records }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

describe("storage owner enumeration", () => {
  test("the indexed enumeration agrees with the key-text enumeration", async () => {
    const store = await open()
    await seed(store, [
      ...[0, 1, 2].map((index) => ({
        key: ["sessions", "scope_a", "ses_one", "rollout", "runs", `run_${index}`, "info"],
        kind: "rollout",
        scopeID: "scope_a",
        sessionID: "ses_one",
        updated: 1_700_000_000_000 + index,
      })),
      ...[0, 1].map((index) => ({
        key: ["sessions", "scope_a", "ses_two", "rollout", "runs", `run_${index}`, "info"],
        kind: "rollout",
        scopeID: "scope_a",
        sessionID: "ses_two",
        updated: 1_700_000_100_000 + index,
      })),
      {
        key: ["sessions", "scope_b", "ses_three", "rollout", "runs", "run_0", "info"],
        kind: "rollout",
        scopeID: "scope_b",
        sessionID: "ses_three",
        updated: 1_700_000_200_000,
      },
      {
        key: ["operations", "scope_a", "op_one", "rollout", "runs", "run_0", "info"],
        kind: "operations",
        scopeID: "",
        sessionID: "",
        updated: 1_700_000_300_000,
      },
    ])

    const owners = await store.evidenceOwners()

    // The gate: the replacement names the same owners with the same recency as
    // the statement it replaces.
    expect(sessionOwners(owners)).toEqual(await keyTextRolloutOwners(store))
    expect(sessionOwners(owners)).toEqual([
      { key: "sessions/scope_a/ses_one/rollout", newest: 1_700_000_000_002, records: 3 },
      { key: "sessions/scope_a/ses_two/rollout", newest: 1_700_000_100_001, records: 2 },
      { key: "sessions/scope_b/ses_three/rollout", newest: 1_700_000_200_000, records: 1 },
    ])

    // The gate: the prefix retention prunes through is the canonical owner
    // composer's output rather than a re-typed literal, and it addresses the
    // rows that are actually stored. Pruning is irreversible, so a prefix that
    // drifted from the key layout would delete a subtree that is not this
    // evidence.
    const rolloutOwners = owners.filter((owner) => owner.kind === "session")
    for (const owner of rolloutOwners) {
      expect(owner.keyPrefix).toEqual(
        StoragePath.sessionRolloutRoot(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.ownerID)),
      )
    }
    const stored = await driver(store).query(
      "SELECT key_text FROM storage_records WHERE namespace = ? AND kind = 'rollout' AND body IS NOT NULL",
      [store.options.namespace],
    )
    expect(stored).toHaveLength(6)
    for (const row of stored) {
      const key = JSON.parse(String(row.key_text)) as string[]
      const owner = rolloutOwners.find((candidate) => candidate.scopeID === key[1] && candidate.ownerID === key[2])
      expect(owner).toBeDefined()
      expect(key.slice(0, owner!.keyPrefix.length)).toEqual(owner!.keyPrefix)
    }

    // Operation owners keep their own key-text branch, unchanged.
    expect(owners.filter((owner) => owner.kind === "operation")).toEqual([
      {
        keyPrefix: ["operations", "scope_a", "op_one", "rollout"],
        kind: "operation",
        scopeID: "scope_a",
        ownerID: "op_one",
        newest: 1_700_000_300_000,
        records: 1,
      },
    ])
  })

  test("a rollout row without owner columns is skipped rather than pruned through an unaddressable prefix", async () => {
    const store = await open()
    await seed(store, [
      {
        key: ["sessions", "scope_c", "", "rollout", "runs", "run_0", "info"],
        kind: "rollout",
        scopeID: "scope_c",
        sessionID: "",
        updated: 1_700_000_400_000,
      },
      { key: ["rollout", "orphan"], kind: "rollout", scopeID: "", sessionID: "", updated: 1_700_000_500_000 },
    ])

    // The key-text form kept the first row because its key happened to be four
    // segments long. Retention must not delete irreversible evidence through an
    // owner prefix it cannot reconstruct, so the columns decide and empty
    // columns mean "not an owner".
    expect(await store.evidenceOwners()).toEqual([])
  })

  test("opening a store creates the owner enumeration index", async () => {
    const store = await open()
    const rows = await driver(store).query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'storage_records_owner'",
    )
    expect(rows).toHaveLength(1)
  })

  test("the owner index migration creates a missing index and is idempotent", async () => {
    const store = await open()
    const present = async () => {
      const rows = await driver(store).query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'storage_records_owner'",
      )
      return rows.length
    }
    // A store created before this index existed is the case the migration is
    // for: its schema already ran, so only the migration can add the index.
    await store.dropIndexIfExists(StorageRecordsOwnerIndex.index)
    expect(await present()).toBe(0)

    await Storage.provide({ store, artifactDirectory: root }, () => StorageRecordsOwnerIndex.run())
    expect(await present()).toBe(1)

    // An interrupted build or a repeated run converges instead of failing.
    await Storage.provide({ store, artifactDirectory: root }, () => StorageRecordsOwnerIndex.run())
    expect(await present()).toBe(1)
  })

  test("postgres accepts the same index creation", async () => {
    if (!process.env.SYNERGY_TEST_POSTGRES_URL) return
    const store = await open("postgres")
    // The migration runs the shared DDL on both engines; `IF NOT EXISTS` is a
    // no-op the second time, which is what keeps a re-run safe.
    await expect(
      Storage.provide({ store, artifactDirectory: root }, () => StorageRecordsOwnerIndex.run()),
    ).resolves.toBeUndefined()
    await expect(
      Storage.provide({ store, artifactDirectory: root }, () => StorageRecordsOwnerIndex.run()),
    ).resolves.toBeUndefined()
  })

  test("the enumeration seeks the owner index instead of grouping through a temporary b-tree", async () => {
    const store = await open()
    await seed(
      store,
      Array.from({ length: 20_000 }, (_, index) => ({
        key: ["sessions", `scope_${index % 50}`, `ses_${index % 50}`, "rollout", "runs", `run_${index}`, "info"],
        kind: "rollout",
        scopeID: `scope_${index % 50}`,
        sessionID: `ses_${index % 50}`,
        updated: 1_700_000_000_000 + index,
      })),
    )

    const plan = await driver(store).query(
      `EXPLAIN QUERY PLAN SELECT scope_id, session_id, MAX(updated) AS newest, COUNT(*) AS records FROM storage_records WHERE namespace = ? AND kind = 'rollout' AND body IS NOT NULL GROUP BY scope_id, session_id`,
      [store.options.namespace],
    )
    const detail = plan.map((row) => String(row.detail)).join(" | ")
    expect(detail).toContain("storage_records_owner")
    expect(detail).not.toContain("TEMP B-TREE")
    expect(detail).not.toContain("SCAN storage_records")
  })
})
