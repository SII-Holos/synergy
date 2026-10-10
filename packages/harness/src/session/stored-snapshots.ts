import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { Storage } from "../storage/storage"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotLease } from "./snapshot-lease"

const chunkBytes = 4 * 1024 * 1024
const Chunk = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(chunkBytes),
})
const Manifest = z.object({
  version: z.literal(1),
  root: z.string().regex(/^[a-f0-9]{40}$/),
  packs: z
    .array(z.object({ chunks: z.array(Chunk).min(1).max(32768) }))
    .min(1)
    .max(64),
})

/** SQL owns published roots; self-contained Git packs are reconstructible cache content. */
export function storedSnapshots(options: { maxBytes?: number } = {}): SnapshotStore.Persistence {
  const maxBytes = options.maxBytes ?? 8 * 1024 ** 3
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid snapshot storage byte limit")
  const key = (scopeID: string, sessionID: string, root: string) => {
    SnapshotStore.component(scopeID)
    SnapshotStore.component(sessionID)
    if (!SnapshotStore.OID.test(root)) throw new Error("Invalid durable snapshot root")
    return ["sessions", scopeID, sessionID, "snapshot_content", root]
  }
  async function read(scopeID: string, sessionID: string, root: string) {
    const value = await SnapshotStore.optional<unknown>([...key(scopeID, sessionID, root), "manifest"])
    if (value === undefined) return
    const manifest = Manifest.parse(value)
    if (manifest.root !== root) throw new Error("Snapshot manifest root mismatch")
    const bytes = manifest.packs.reduce((sum, pack) => sum + pack.chunks.reduce((n, chunk) => n + chunk.bytes, 0), 0)
    if (bytes > maxBytes) throw new Error("Snapshot content exceeds storage byte limit")
    return manifest
  }
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
  async function cachedTree(repository: string, root: string, signal?: AbortSignal) {
    try {
      for await (const object of SnapshotGit.lines(
        repository,
        ["rev-list", "--objects", "--missing=print", "--no-object-names", root, "--"],
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
    async retain(scopeID, sessionID, root, repository, signal) {
      signal?.throwIfAborted()
      if (await read(scopeID, sessionID, root)) return
      const prefix = key(scopeID, sessionID, root)
      await temporary(scopeID, async (directory) => {
        const target = path.join(directory, "store.git")
        await SnapshotStore.initializeBareRepository(target)
        await using catalog = await SnapshotTransfer.Catalog.create(target, signal)
        await catalog.import(repository, { roots: [root], requiredTrees: [root], signal })
        const packDirectory = path.join(target, "objects", "pack")
        const files = (await fs.readdir(packDirectory)).filter((file) => /^pack-[a-f0-9]{40}\.pack$/.test(file)).sort()
        if (!files.length) throw new Error("Durable snapshot capture produced no pack")
        const manifest: z.infer<typeof Manifest> = { version: 1, root, packs: [] }
        const prepared: Storage.PreparedBinary[] = []
        let size = 0
        try {
          for (const [packIndex, name] of files.entries()) {
            const pack = { chunks: [] as z.infer<typeof Chunk>[] }
            manifest.packs.push(pack)
            const file = await fs.open(path.join(packDirectory, name), "r")
            try {
              const buffer = Buffer.allocUnsafe(chunkBytes)
              for (;;) {
                signal?.throwIfAborted()
                const { bytesRead } = await file.read(buffer, 0, chunkBytes, null)
                if (!bytesRead) break
                size += bytesRead
                if (size > maxBytes) throw new Error("Snapshot content exceeds storage byte limit")
                const bytes = buffer.subarray(0, bytesRead)
                const id = String(pack.chunks.length)
                prepared.push(await Storage.prepareBinary([...prefix, "packs", String(packIndex), id], bytes))
                pack.chunks.push({ bytes: bytesRead, sha256: createHash("sha256").update(bytes).digest("hex") })
              }
            } finally {
              await file.close()
            }
          }
          Manifest.parse(manifest)
          signal?.throwIfAborted()
          await Storage.transaction(async () => {
            if ((await SnapshotStore.owner(scopeID, sessionID))?.backend === "deleted")
              throw new Error("Snapshot owner was deleted during publication")
            if (await read(scopeID, sessionID, root)) return
            for (const item of prepared) await Storage.publishPreparedBinary(item)
            await Storage.write([...prefix, "manifest"], manifest)
          })
        } finally {
          for (const item of prepared) item[Symbol.dispose]()
        }
      })
    },
    async restore(scopeID, sessionID, root, repository, signal) {
      signal?.throwIfAborted()
      const manifest = await read(scopeID, sessionID, root)
      if (!manifest) return false
      return withFileLock(
        { directory: SnapshotLease.directory(), key: `snapshot-init:${repository}`, signal },
        async () => {
          await SnapshotStore.initializeBareRepository(repository)
          const reference = SnapshotStore.reference(sessionID, root)
          const cached = await SnapshotGit.run(
            ["git", "--git-dir", repository, "rev-parse", "--verify", reference],
            path.dirname(repository),
            undefined,
            signal,
          )
          if (cached.exitCode === 0 && cached.text.trim() === root && (await cachedTree(repository, root, signal)))
            return true
          await temporary(scopeID, async (directory) => {
            for (const [packIndex, pack] of manifest.packs.entries()) {
              const file = path.join(directory, `${packIndex}.pack`)
              const output = await fs.open(file, "wx", 0o600)
              try {
                for (const [chunkIndex, chunk] of pack.chunks.entries()) {
                  signal?.throwIfAborted()
                  const bytes = await Storage.readBinary(
                    [...key(scopeID, sessionID, root), "packs", String(packIndex), String(chunkIndex)],
                    { maxBytes: chunk.bytes },
                  )
                  if (
                    bytes.byteLength !== chunk.bytes ||
                    createHash("sha256").update(bytes).digest("hex") !== chunk.sha256
                  )
                    throw new Error("Snapshot chunk verification failed")
                  await output.writeFile(bytes)
                }
                await output.sync()
              } finally {
                await output.close()
              }
              await SnapshotGit.checked(repository, ["index-pack", "--stdin", "--strict"], { signal, input: file })
            }
            if ((await SnapshotGit.checked(repository, ["cat-file", "-t", root], { signal })) !== "tree")
              throw new Error("Durable snapshot root is not a tree")
            await SnapshotGit.checked(repository, ["update-ref", reference, root], { signal })
          })
          return true
        },
      )
    },
  }
}
