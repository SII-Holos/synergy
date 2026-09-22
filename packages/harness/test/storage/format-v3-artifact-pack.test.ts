import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { StorageFormatV3Migration } from "../../src/storage/format-v3-migration"
import { createV2Store, inspect, type V2Record } from "./format-v3-fixture"

const NAMESPACE = "artifact-pack-layout"

/**
 * The pack-keyed statement the store itself issues for `artifactPacks`, so the
 * plan assertion below covers a real read shape rather than a copy of it.
 */
const PACK_QUERY =
  "SELECT DISTINCT pack FROM storage_artifacts WHERE namespace = ? AND pack > ? ORDER BY pack LIMIT 256"

function records(): V2Record[] {
  return [
    { key: ["sessions", "scope_a", "ses_one", "info"], body: JSON.stringify({ id: "ses_one" }) },
    { key: ["notes", "alpha", "one"], body: JSON.stringify({ text: "alpha" }) },
  ]
}

/** Pack names the `ArtifactLocation` schema accepts, distinct per row. */
function artifacts(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    key: ["blobs", `blob_${index}`],
    pack: `${index.toString(16).padStart(64, "0")}.pack`,
  }))
}

async function fixture(label: string, count = 3) {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, `${label}-`))
  const filename = path.join(directory, "agent.sqlite")
  createV2Store({ filename, namespace: NAMESPACE, records: records(), artifacts: artifacts(count) })
  const store = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
  return {
    store,
    filename,
    directory,
    async [Symbol.asyncDispose]() {
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * The query plan for `PACK_QUERY`, read from the file directly.
 *
 * The plan is taken on its own connection rather than through the store: SQLite
 * holds a statement open on a table it has planned, and the migration's
 * `DROP`/`RENAME` would then fail with `SQLITE_LOCKED`. An independent reader is
 * also the honest subject for the assertion, since it is one of the readers the
 * index has to serve.
 */
function packPlan(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const query = database.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN " + PACK_QUERY)
    try {
      return query
        .all(NAMESPACE, "")
        .map((row) => row.detail)
        .join(" | ")
    } finally {
      query.finalize()
    }
  } finally {
    database.close()
  }
}

/** The pack column of every artifact row, with its stored type. */
function storedPacks(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const query = database.query<{ key_text: string; pack: string; location: string; storage: string }, []>(
      "SELECT key_text, pack, location, typeof(pack) AS storage FROM storage_artifacts ORDER BY key_text",
    )
    try {
      return query.all()
    } finally {
      query.finalize()
    }
  } finally {
    database.close()
  }
}

test("artifact-pack-generated: a supported engine keeps the derived column and indexes it", () =>
  runtime.run(async () => {
    await using handle = await fixture("pack-generated")
    const { store, filename } = handle

    // No probe override: this asserts the engine the rewrite actually runs on.
    await StorageFormatV3Migration.run({ store })

    // `hidden = 2` is a `VIRTUAL` generated column: the engine derives it and a
    // writer must never name it. A plain column reports 0, so this is the exact
    // distinction the format 3 layout rests on.
    expect(inspect(filename, NAMESPACE).artifactPackColumn()).toEqual({ name: "pack", hidden: 2 })
    // The column is derived from `location`, so it is populated without any writer
    // supplying it: the two agree by construction, not by a backfill.
    for (const row of storedPacks(filename)) {
      expect(row.pack).toBe(JSON.parse(row.location).pack)
      expect(row.storage).toBe("text")
    }
    expect(packPlan(filename)).toContain("storage_artifacts_pack")
    expect(packPlan(filename)).not.toMatch(/SCAN storage_artifacts/)

    // The namespace is readable through the store's own pack-keyed reader.
    const packs: string[] = []
    await store.snapshot(async (tx) => {
      for await (const pack of tx.artifactPacks()) packs.push(pack)
    })
    expect(packs).toEqual(
      artifacts()
        .map((artifact) => artifact.pack)
        .sort(),
    )
  }))

test("artifact-pack-fallback: an unsupported engine stages and backfills a physical column", () =>
  runtime.run(async () => {
    await using handle = await fixture("pack-fallback")
    const { store, filename } = handle

    await StorageFormatV3Migration.run({
      store,
      // The seam the engine's own verdict is injected through, so the fallback is
      // exercised deterministically instead of depending on the host's SQLite.
      supportsGeneratedPack: async () => false,
    })

    // `hidden = 0` is a real column. The name is unchanged, which is what keeps
    // every reader -- including `artifactPacks` and the garbage collector -- and
    // the `storage_artifacts_pack` index definition working unchanged.
    expect(inspect(filename, NAMESPACE).artifactPackColumn()).toEqual({ name: "pack", hidden: 0 })
    // The fallback has to be populated: the copy reads the pack out of each row's
    // own `location`, which is the format 2 writer's behaviour.
    const stored = storedPacks(filename)
    expect(stored).toHaveLength(artifacts().length)
    for (const row of stored) expect(row.pack).toBe(JSON.parse(row.location).pack)

    // The index keeps its name and still answers the pack-keyed read.
    expect(packPlan(filename)).toContain("storage_artifacts_pack")
    expect(packPlan(filename)).not.toMatch(/SCAN storage_artifacts/)
    const packs: string[] = []
    await store.snapshot(async (tx) => {
      for await (const pack of tx.artifactPacks()) packs.push(pack)
    })
    expect(packs).toEqual(
      artifacts()
        .map((artifact) => artifact.pack)
        .sort(),
    )

    // A writer must supply the physical column rather than omit it, and it learns
    // that from the table shape. A reopened store is the case that proves it: the
    // layout is read at open, not carried over from the migration run.
    await store.close()
    const reopened = await TransactionalStore.open({ backend: "sqlite", namespace: NAMESPACE, filename })
    try {
      expect((await reopened.verify()).issues).toEqual([])
      const replacement = "f".repeat(64) + ".pack"
      await reopened.transaction((tx) => {
        const location = { ...JSON.parse(stored[0]!.location), pack: replacement }
        return tx.writeArtifacts([{ key: ["blobs", "blob_new"], location }])
      })
      expect(storedPacks(filename).find((row) => row.key_text.includes("blob_new"))?.pack).toBe(replacement)
    } finally {
      await reopened.close()
    }
  }))

test(
  "artifact-pack-fallback-resumes: an interrupted fallback run converges to the same layout",
  () =>
    runtime.run(async () => {
      await using handle = await fixture("pack-fallback-resume", 1000)
      const { store, filename } = handle

      // Cut after the first committed artifacts batch, which is the state a crash
      // mid-phase leaves: a staged table holding rows and a durable cursor past them.
      let interrupted = false
      await expect(
        StorageFormatV3Migration.run({
          store,
          supportsGeneratedPack: async () => false,
          progress: (current, _total, phase) => {
            if (!interrupted && phase === 3 && current > 0) {
              interrupted = true
              throw new Error("cut-mid-artifacts")
            }
          },
        }),
      ).rejects.toThrow("cut-mid-artifacts")

      // The resumed run must not re-derive the layout, and must not recreate the
      // table its cursor is past: doing either would drop the rows already staged and
      // the swap would install an artifact table missing them.
      await StorageFormatV3Migration.run({ store, supportsGeneratedPack: async () => true })

      expect(inspect(filename, NAMESPACE).artifactPackColumn()).toEqual({ name: "pack", hidden: 0 })
      expect(inspect(filename, NAMESPACE).version()).toBe(3)
      expect(storedPacks(filename)).toHaveLength(artifacts(1000).length)
      expect(packPlan(filename)).toContain("storage_artifacts_pack")
      expect((await store.verify()).issues).toEqual([])
    }),
  30_000,
)

afterRuntimeTests(() => runtime.close())
