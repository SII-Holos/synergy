import { expect, spyOn, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { storageTestRuntime } from "../support/storage-runtime"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { Storage } from "../../src/storage/storage"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { storedSnapshots } from "../../src/session/stored-snapshots"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { StoredSnapshotContent as Content } from "../../src/session/stored-snapshot-content"
import { runMigrations } from "../../src/migration"

test("stored Snapshot capture seals bounded paged descriptors and restores exact binary content after cache loss", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "paged-snapshot-"))
  const runtime = await storageTestRuntime()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory, "authority.sqlite"),
    namespace: "snapshots",
  })
  const handle = { store, artifactDirectory: path.join(directory, "content") }
  try {
    await runtime.run(() =>
      Storage.provide(handle, async () => {
        SnapshotStore.registerStorage(storedSnapshots())
        const operation = await SnapshotStore.resolveRepository("scope", "session")
        await SnapshotStore.initialize(operation)
        const bytes = randomBytes(4 * 1024 * 1024 + 17)
        const filename = path.join(directory, "binary")
        await fs.writeFile(filename, bytes)
        const blob = await SnapshotStore.command(operation.repository, ["hash-object", "-w", filename])
        const root = await SnapshotStore.command(
          operation.repository,
          ["mktree"],
          undefined,
          `100644 blob ${blob}\tfile.bin\n`,
        )
        await SnapshotStore.retainMany("scope", "session", [root])
        const header = await Storage.read<Record<string, unknown>>([
          ...Content.key("scope", "session", root),
          "manifest",
        ])
        expect(header.version).toBe(2)
        expect(header.packs).toBeUndefined()
        expect(Buffer.byteLength(JSON.stringify(header))).toBeLessThan(1024)
        expect(header.chunkCount).toBe(2)
        expect(await Array.fromAsync(SnapshotStore.roots("scope", "session"))).toEqual([root])
        await fs.rm(operation.repository, { recursive: true, force: true })
        expect(await SnapshotStore.owns("scope", "session", root)).toBeTrue()
        const result = await SnapshotGit.run(
          ["git", "--git-dir", operation.repository, "show", `${root}:file.bin`],
          path.dirname(operation.repository),
        )
        expect(result.exitCode).toBe(0)
        expect(result.bytes).toEqual(bytes)
        const captured = Content.Header.parse(header)
        const references = await Array.fromAsync(
          Content.references({ scopeID: "scope", retentionID: "session", manifest: captured }),
        )
        await Storage.transaction(async (tx) => {
          for (const ref of references)
            await tx.writeArtifacts([
              {
                key: [...Content.legacyKey("scope", "session", root), "packs", "0", String(ref.index)],
                location: await tx.artifact(ref.key),
              },
            ])
          await Storage.write([...Content.legacyKey("scope", "session", root), "manifest"], {
            version: 1,
            root,
            packs: [{ chunks: references.map(({ sha256, bytes }) => ({ sha256, bytes })) }],
          })
          await Storage.removeTree(Content.key("scope", "session", root))
          await Storage.remove(Content.legacyFenceKey("scope", "session", root))
        })
        await runMigrations({ targetDomain: "stored-snapshot-content", output: "silent" })
        expect((await Content.read("scope", "session", root))?.version).toBe(1)
        await runMigrations({ targetDomain: "stored-snapshot-content", maintenance: true, output: "silent" })
        const upgraded = Content.Header.parse(await Content.read("scope", "session", root))
        expect(upgraded.layout).toBe("chunks-v2")
        for await (const ref of Content.references({ scopeID: "scope", retentionID: "session", manifest: upgraded }))
          await Storage.snapshot(async (tx) => {
            expect(await tx.artifact(ref.key)).toEqual(
              await tx.artifact([...Content.legacyKey("scope", "session", root), "packs", "0", String(ref.index)]),
            )
          })
        await runMigrations({ targetDomain: "stored-snapshot-content", maintenance: true, output: "silent" })
        expect(await Content.read("scope", "session", root)).toEqual(upgraded)
        expect(
          (await Storage.read<{ version: number }>([...Content.legacyKey("scope", "session", root), "manifest"]))
            .version,
        ).toBe(1)
        await fs.rm(operation.repository, { recursive: true, force: true })
        expect(await SnapshotStore.owns("scope", "session", root)).toBeTrue()
        expect(
          (
            await SnapshotGit.run(
              ["git", "--git-dir", operation.repository, "show", `${root}:file.bin`],
              path.dirname(operation.repository),
            )
          ).bytes,
        ).toEqual(bytes)
        await storedSnapshots().release?.("scope", "session")
        expect(await Content.read("scope", "session", root)).toBeUndefined()
        expect(await Array.fromAsync(Content.roots("scope", "session"))).toEqual([])
      }),
    )
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("descriptor windows cross the previous flat limit without loading an aggregate manifest or silently accepting an incomplete seal", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "snapshot-descriptors-"))
  const runtime = await storageTestRuntime()
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(directory, "authority.sqlite"),
    namespace: "snapshots",
  })
  try {
    await runtime.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(directory, "content") }, async () => {
        const root = "a".repeat(40)
        const writer = new Content.Writer("scope", "retention", root, "descriptor-fixture", "chunks-v2")
        for (let index = 0; index < 100001; index++)
          await writer.append({ pack: 0, index, sha256: "b".repeat(64), bytes: 1 })
        const header = await writer.seal()
        expect(header.chunkCount).toBe(100001)
        expect(header).not.toHaveProperty("packs")
        expect(Content.Header.parse({ ...header, totalBytes: 9 * 1024 ** 3 }).totalBytes).toBe(9 * 1024 ** 3)
        const query = { scopeID: "scope", retentionID: "retention", manifest: header }
        using reads = spyOn(Storage, "readBinary")
        const first = Content.references(query)
        expect((await first.next()).value?.index).toBe(0)
        expect(reads).toHaveBeenCalledTimes(1)
        await expect(first.return(undefined)).rejects.toThrow("must complete")
        let count = 0
        for await (const ref of Content.references(query)) expect(ref.index).toBe(count++)
        expect(count).toBe(100001)
        expect(reads.mock.calls.every(([, options]) => options?.maxBytes === Content.pageBytes)).toBeTrue()
        const controller = new AbortController()
        const cancelled = Content.references({ ...query, signal: controller.signal })
        await cancelled.next()
        const reason = new Error("Stop the current descriptor page")
        controller.abort(reason)
        await expect(cancelled.next()).rejects.toBe(reason)
        const pageKey = Content.pageKey("scope", "retention", header, 1)
        await Storage.removeTree(pageKey)
        await expect(Array.fromAsync(Content.references(query))).rejects.toThrow()
      }),
    )
  } finally {
    await runtime.close()
    await store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
