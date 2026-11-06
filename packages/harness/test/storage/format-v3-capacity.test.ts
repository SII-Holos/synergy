import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { afterAll, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { RecordCodec } from "../../src/storage/record-codec"
import { createV2Store, compressible } from "./format-v3-fixture"

const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "format-v3-capacity-"))
const stores: TransactionalStore[] = []

test.each(["records", "nodes"])("the %s preflight includes artifact copies that have not started", (phase) =>
  runtime.run(async () => {
    const namespace = `artifacts-${phase}`
    const dir = await fs.mkdtemp(path.join(root, `${namespace}-`))
    const filename = path.join(dir, "agent.sqlite")
    createV2Store({
      filename,
      namespace,
      records: [{ key: ["sessions", "scope", "session", "info"], body: JSON.stringify({ id: "session" }) }],
      artifacts: Array.from({ length: 400 }, (_, index) => ({
        key: ["artifacts", `artifact-${index}`],
        pack: `pack-${index}`,
      })),
      incrementalVacuum: true,
    })
    const store = await TransactionalStore.open({ backend: "sqlite", namespace, filename })
    stores.push(store)
    if (phase === "nodes") {
      await expect(
        StorageFormatV3Migration.run({
          store,
          progress: (_current, _total, stage) => {
            if (stage === 2) throw new Error("interrupt-before-nodes")
          },
        }),
      ).rejects.toThrow("interrupt-before-nodes")
    }
    using _disk = spyOn(fs, "statfs").mockImplementation((async () => ({
      bavail: 16n,
      bsize: 4096n,
    })) as unknown as typeof fs.statfs)
    await expect(StorageFormatV3Migration.run({ store })).rejects.toThrow("of free space")
    const [record] = await store.snapshot(
      (tx) =>
        tx.raw.query<{ version: number | bigint }>("SELECT version FROM storage_namespaces WHERE namespace = ?", [
          namespace,
        ]),
      { singleStatement: true },
    )
    expect(Number(record.version)).toBe(2)
  }),
)

afterAll(() =>
  runtime.run(async () => {
    await Promise.all(stores.map((store) => store.close().catch(() => {})))
    await fs.rm(root, { recursive: true, force: true })
  }),
)

/**
 * A store whose records, nodes and artifact rows together cost more than a page,
 * so the preflight's sampled figure is a real measurement rather than a rounding
 * artifact. Bodies are a mix of compressible and small so the sample reflects the
 * re-encoding the copy performs.
 */
function fixtureRecords() {
  const records: Array<{ key: string[]; body: string | null }> = []
  for (let index = 0; index < 400; index++) {
    const key = ["sessions", `scope_${index % 4}`, `ses_${index}`]
    records.push({ key: [...key, "info"], body: JSON.stringify({ id: `ses_${index}` }) })
    records.push({
      key: [...key, "rollout", "runs", `run_${index}`, "info"],
      body: compressible(`rollout evidence ${index}`),
    })
    records.push({
      key: [...key, "messages", `msg_${index}`, "info"],
      body: JSON.stringify({ id: `msg_${index}`, role: "user", text: "question ".repeat(20) }),
    })
  }
  // Tombstones carry no body and must not be counted as staged payload.
  records.push({ key: ["sessions", "scope_0", "ses_0", "gone"], body: null })
  return records
}

async function open(label: string) {
  const dir = await fs.mkdtemp(path.join(root, `${label}-`))
  const filename = path.join(dir, "agent.sqlite")
  createV2Store({ filename, namespace: label, records: fixtureRecords(), incrementalVacuum: true })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: label, filename })
  stores.push(store)
  return { store, filename }
}

/**
 * A floor under what the copy must write: every staged record body costs at least
 * its re-encoded size, because that is exactly what the copy stores, and every
 * staged row also carries its key text. Compressing bodies is why this floor sits
 * far below the format 2 payload the same rows occupy today.
 */
function stagedPayloadFloor(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const rows = database
      .query<{ body: string | null; key_text: string }, []>("SELECT body, key_text FROM storage_records")
      .all()
    const recordBytes = rows.reduce((total, row) => {
      if (row.body === null) return total
      const encoded = RecordCodec.reencode(row.body)
      return (
        total +
        Buffer.byteLength(row.key_text) +
        (typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength)
      )
    }, 0)
    const nodeBytes = database
      .query<{ bytes: number | null }, []>("SELECT SUM(length(segment)) AS bytes FROM storage_nodes")
      .get()!.bytes
    return recordBytes + Number(nodeBytes ?? 0)
  } finally {
    database.close()
  }
}

test("the preflight passes a store whose volume can hold the second copy", () =>
  runtime.run(async () => {
    const { store, filename } = await open("ample")
    const live = (await fs.stat(filename)).size
    const consulted: bigint[] = []
    using _disk = spyOn(fs, "statfs").mockImplementation((async () => {
      // A volume with far more room than this store will ever need.
      consulted.push(1024n)
      return { bavail: 1024n * 1024n * 1024n, bsize: 4096n }
    }) as unknown as typeof fs.statfs)

    await expect(StorageFormatV3Migration.run({ store })).resolves.toBeUndefined()

    // The check runs before the copy phases and once per run, and a volume with
    // room is never refused.
    expect(consulted).toHaveLength(1)
    expect((await store.verify()).issues).toEqual([])
    expect(live).toBeGreaterThan(0)
  }))

test("a volume that cannot hold the second copy fails with the actual shortfall", () =>
  runtime.run(async () => {
    const { store, filename } = await open("scarce")
    const liveFileBytes = (await fs.stat(filename)).size
    const stagedFloor = stagedPayloadFloor(filename)
    const available = 4096n
    const consulted: number[] = []
    using _disk = spyOn(fs, "statfs").mockImplementation((async () => {
      consulted.push(1)
      return { bavail: 1n, bsize: available }
    }) as unknown as typeof fs.statfs)

    const failure = await StorageFormatV3Migration.run({ store }).then(
      () => undefined,
      (error: unknown) => error as Error,
    )

    expect(failure?.name).toBe("StorageIntegrityError")
    // The check consults the volume once per run rather than once per batch.
    expect(consulted).toHaveLength(1)

    const match = /needs (\d+) bytes .*has (\d+) bytes/.exec(failure!.message)
    expect(match).not.toBeNull()
    const required = Number(match![1])
    const reported = Number(match![2])
    // The message names the real numbers an operator has to act on: what the
    // rewrite requires, and what this volume actually has.
    expect(reported).toBe(Number(available))
    // The requirement is derived from what the copy stores rather than from a
    // multiple of the file. It covers the staged payload it is about to write, and
    // it stays below the store's own size -- which a 2x-file rule could not: that
    // would demand twice the whole store and refuse volumes that plainly have room.
    expect(required).toBeGreaterThanOrEqual(stagedFloor)
    expect(required).toBeLessThan(liveFileBytes)
    // Freeing the reported shortfall is therefore a sufficient instruction.
    expect(required - reported).toBeGreaterThan(0)
    // Nothing was rewritten: a refused preflight has to fail before the copies run.
    expect((await store.verify()).records).toBeGreaterThan(0)
    expect((await store.read<{ id: string }>(["sessions", "scope_0", "ses_0", "info"])).id).toBe("ses_0")
  }))

test("a run resumed past the copy phases is not refused for headroom it already paid", () =>
  runtime.run(async () => {
    const { store } = await open("resumed")
    await StorageFormatV3Migration.run({ store })

    using _disk = spyOn(fs, "statfs").mockImplementation((async () => {
      throw new Error("the preflight must not consult the volume once the copies are built")
    }) as unknown as typeof fs.statfs)
    await StorageFormatV3Migration.run({ store })
    expect((await store.verify()).issues).toEqual([])
  }))

test("resumed node derivation discounts the durable nodes already staged", () =>
  runtime.run(async () => {
    const { store } = await open("node-cursor")
    const interrupt = async (after: number) =>
      expect(
        StorageFormatV3Migration.run({
          store,
          progress: (current, _total, phase) => {
            if (phase === 2 && current >= after) throw new Error("interrupt nodes")
          },
        }),
      ).rejects.toThrow("interrupt nodes")
    const required = async () => {
      using _disk = spyOn(fs, "statfs").mockImplementation((async () => ({
        bavail: 0n,
        bsize: 4096n,
      })) as unknown as typeof fs.statfs)
      const error = await StorageFormatV3Migration.run({ store }).then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      const match = /needs (\d+) bytes/.exec(error?.message ?? "")
      expect(match).not.toBeNull()
      return Number(match![1])
    }
    await interrupt(0)
    const before = await required()
    await interrupt(768)
    const after = await required()
    expect(after).toBeLessThan(before)
    await StorageFormatV3Migration.run({ store })
    expect((await store.verify()).issues).toEqual([])
  }))

afterRuntimeTests(() => runtime.close())
