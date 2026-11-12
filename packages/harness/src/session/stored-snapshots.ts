import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Storage } from "../storage/storage"
import { StorageMutationGuard } from "../storage/mutation-guard"
import { StoragePath } from "../storage/path"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotPath } from "./snapshot-path"
import { StoredSnapshotContent as Content } from "./stored-snapshot-content"
import {
  StoredSnapshotMaintenance as Maintenance,
  registerStoredSnapshotMigrations,
} from "./stored-snapshot-maintenance"

export function storedSnapshots(options: { maxBytes?: number } = {}): SnapshotStore.Persistence {
  registerStoredSnapshotMigrations()
  const maxBytes = options.maxBytes
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0))
    throw new Error("Invalid snapshot storage byte budget")
  const read = (scopeID: string, retentionID: string, root: string) =>
    Content.read(scopeID, retentionID, root, maxBytes)
  async function temporary<T>(scopeID: string, action: (directory: string) => Promise<T>) {
    const parent = SnapshotStore.cache(scopeID)
    await fs.mkdir(parent, { recursive: true })
    const directory = await fs.mkdtemp(path.join(parent, "durable-"))
    try {
      return await action(directory)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  async function cachedTrees(repository: string, roots: string[], signal?: AbortSignal) {
    try {
      for await (const object of SnapshotGit.lines(
        repository,
        ["rev-list", "--objects", "--missing=print", "--no-object-names", ...roots, "--"],
        { signal },
      ))
        if (object.startsWith("?")) return false
      return true
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
  return {
    roots: Content.roots,
    async release(scopeID, retentionID, ownerSessionID) {
      await Storage.transaction(async (tx) => {
        if (ownerSessionID)
          await StorageMutationGuard.assert(tx, [StoragePath.snapshotOwner(scopeID, ownerSessionID)], false)
        const original = await SnapshotStore.owner(scopeID, retentionID)
        if (original) {
          await StorageMutationGuard.assert(tx, [StoragePath.snapshotOwner(scopeID, retentionID)], false)
          if (ownerSessionID && ownerSessionID !== retentionID && original.backend !== "deleted")
            throw new Error("Snapshot retention is still claimed by another logical owner")
        }
        await Storage.write(Content.legacyFenceKey(scopeID, retentionID), { version: 1 })
        await Storage.removeTree([
          "snapshot-v2",
          SnapshotStore.component(scopeID),
          "content",
          SnapshotStore.component(retentionID),
        ])
      })
    },
    async retain(scopeID, retentionID, root, repository, signal, ownerSessionID, commitGuard) {
      const assert = () => {
        signal?.throwIfAborted()
        commitGuard?.()
      }
      assert()
      const retained = await read(scopeID, retentionID, root)
      assert()
      if (retained) return
      return SnapshotLease.use(
        scopeID,
        false,
        () =>
          withFileLock(
            { directory: SnapshotLease.directory(), key: `snapshot-content:${scopeID}:${retentionID}:${root}`, signal },
            async () => {
              assert()
              const retained = await read(scopeID, retentionID, root)
              assert()
              if (retained) return
              const intent = await Maintenance.begin(scopeID, retentionID, root, ownerSessionID)
              const { contentID } = intent
              const content = { root, contentID }
              let published = false
              let unknown = false
              try {
                assert()
                await temporary(scopeID, async (directory) => {
                  const target = path.join(directory, "store.git")
                  await SnapshotStore.initializeBareRepository(target)
                  assert()
                  await using catalog = await SnapshotTransfer.Catalog.create(target, signal)
                  const imported = await catalog.import(repository, { roots: [root], requiredTrees: [root], signal })
                  assert()
                  if (!imported.keep) throw new Error("Durable snapshot capture produced no pack")
                  const filename = path.join(target, "objects", "pack", `pack-${imported.keep}.pack`)
                  const file = await fs.open(filename, "r")
                  const writer = new Content.Writer(scopeID, retentionID, root, contentID, "chunks-v2")
                  let bytes = 0
                  try {
                    const buffer = Buffer.allocUnsafe(Content.chunkBytes)
                    let index = 0
                    for (;;) {
                      assert()
                      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
                      assert()
                      if (!bytesRead) break
                      bytes += bytesRead
                      if (maxBytes !== undefined && bytes > maxBytes)
                        throw new Error("Snapshot content exceeds the explicitly selected byte budget")
                      const chunk = buffer.subarray(0, bytesRead)
                      const ref = {
                        pack: 0,
                        index: index++,
                        bytes: bytesRead,
                        sha256: createHash("sha256").update(chunk).digest("hex"),
                      }
                      using prepared = await Storage.prepareBinary(
                        [...Content.contentKey(scopeID, retentionID, content), "packs", "0", String(ref.index)],
                        chunk,
                      )
                      assert()
                      await Storage.transaction(
                        () => {
                          assert()
                          return Storage.publishPreparedBinary(prepared)
                        },
                        { commitGuard: assert },
                      )
                      assert()
                      await writer.append(ref)
                      assert()
                    }
                  } finally {
                    await file.close()
                  }
                  const header = await writer.seal()
                  assert()
                  published = await Maintenance.publish(intent, header, undefined, signal, commitGuard)
                  assert()
                })
              } catch (error) {
                unknown = error instanceof Storage.CommitUnknownError
                throw error
              } finally {
                let current = true
                try {
                  commitGuard?.()
                } catch {
                  current = false
                }
                if (!published && !unknown && current) await Maintenance.discard(intent)
              }
            },
          ),
        { signal },
      )
    },
    async restore(scopeID, retentionID, roots, repository, signal) {
      signal?.throwIfAborted()
      const restored = new Set<string>()
      return SnapshotLease.use(
        scopeID,
        false,
        async () => {
          for (let offset = 0; offset < roots.length; offset += 32) {
            const manifests = new Map<string, Content.Manifest>()
            for (const root of roots.slice(offset, offset + 32)) {
              if (restored.has(root)) continue
              const manifest = await read(scopeID, retentionID, root)
              if (manifest) manifests.set(root, manifest)
            }
            if (!manifests.size) continue
            await withFileLock(
              { directory: SnapshotLease.directory(), key: `snapshot-init:${repository}`, signal },
              async () => {
                if (!(await SnapshotPath.exists(path.join(repository, "HEAD"))))
                  await SnapshotStore.initializeBareRepository(repository)
                const references = new Map(
                  [...manifests.keys()].map((root) => [SnapshotStore.reference(retentionID, root), root]),
                )
                const refs = await SnapshotGit.checked(
                  repository,
                  ["for-each-ref", "--format=%(refname) %(objectname)", ...references.keys()],
                  { signal },
                )
                const cached = refs.split("\n").flatMap((line) => {
                  const [ref, root] = line.split(" ")
                  return root && references.get(ref) === root ? [root] : []
                })
                const complete = cached.length > 0 && (await cachedTrees(repository, cached, signal))
                for (const [root, manifest] of manifests) {
                  if (cached.includes(root) && (complete || (await cachedTrees(repository, [root], signal)))) continue
                  await temporary(scopeID, async (directory) => {
                    let output: Awaited<ReturnType<typeof fs.open>> | undefined
                    let previousPack = -1
                    const completePack = async () => {
                      if (!output) return
                      await output.sync()
                      await output.close()
                      output = undefined
                      await SnapshotGit.checked(repository, ["index-pack", "--stdin", "--strict"], {
                        signal,
                        input: path.join(directory, `${previousPack}.pack`),
                      })
                    }
                    try {
                      for await (const ref of Content.references({ scopeID, retentionID, manifest, signal })) {
                        signal?.throwIfAborted()
                        if (ref.pack !== previousPack) {
                          await completePack()
                          previousPack = ref.pack
                          output = await fs.open(path.join(directory, `${ref.pack}.pack`), "wx", 0o600)
                        }
                        const bytes = await Storage.readBinary(ref.key, { maxBytes: ref.bytes })
                        if (
                          bytes.byteLength !== ref.bytes ||
                          createHash("sha256").update(bytes).digest("hex") !== ref.sha256
                        )
                          throw new Error("Snapshot chunk verification failed")
                        if (!output) throw new Error("Snapshot pack stream has no native output")
                        await output.writeFile(bytes)
                      }
                      await completePack()
                    } finally {
                      await output?.close()
                    }
                    if ((await SnapshotGit.checked(repository, ["cat-file", "-t", root], { signal })) !== "tree")
                      throw new Error("Durable snapshot root is not a tree")
                    for await (const missing of SnapshotGit.lines(
                      repository,
                      ["rev-list", "--objects", "--missing=print", "--no-object-names", root, "--"],
                      { signal },
                    ))
                      if (missing.startsWith("?")) throw new Error("Durable snapshot graph is incomplete")
                    await SnapshotStore.withReferences(
                      scopeID,
                      retentionID,
                      () =>
                        SnapshotGit.checked(
                          repository,
                          ["update-ref", SnapshotStore.reference(retentionID, root), root],
                          { signal },
                        ),
                      signal,
                    )
                  })
                }
              },
            )
            for (const root of manifests.keys()) restored.add(root)
          }
          return restored
        },
        { signal },
      )
    },
  }
}
