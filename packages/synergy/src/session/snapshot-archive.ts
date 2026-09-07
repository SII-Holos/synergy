import fs from "node:fs/promises"
import path from "node:path"
import { ServerProcessLock } from "../util/server-process-lock"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotRecords } from "./snapshot-records"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotGit } from "./snapshot-git"

export namespace SnapshotArchive {
  export async function lockHomes(roots: string[]) {
    const locks: AsyncDisposable[] = []
    const release = async () => {
      for (const lock of locks.reverse()) await lock[Symbol.asyncDispose]()
    }
    try {
      for (const root of [...new Set(roots.map((root) => path.resolve(root)))].sort()) {
        const server = await ServerProcessLock.acquire(path.join(root, "state", "daemon", "runtime-lock.json"))
        locks.push({ [Symbol.asyncDispose]: server.release })
        locks.push(await SnapshotLease.acquireHome(path.join(root, "data")))
      }
      return { [Symbol.asyncDispose]: release }
    } catch (error) {
      await release()
      throw error
    }
  }

  async function read(file: string): Promise<unknown | undefined> {
    return Bun.file(file)
      .json()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
  }

  async function write(file: string, value: unknown) {
    await Storage.writeJsonAtomic(file, JSON.stringify(value), { durable: true })
  }

  async function copyMetadata(source: string, target: string) {
    for (const entry of await SnapshotRecords.entries(source)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const from = path.join(source, entry.name)
      const to = path.join(target, entry.name)
      const incoming = await read(from)
      const existing = await read(to)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(incoming)) {
        throw new SnapshotStore.StorageError("Snapshot maintenance records conflict; finish recovery before merging")
      }
      await write(to, incoming)
    }
  }

  async function references(repo: string) {
    const refs = new Map<string, string>()
    for await (const line of SnapshotGit.lines(repo, ["for-each-ref", "--format=%(objectname) %(refname)"])) {
      const [oid, ref] = line.split(" ")
      if (!SnapshotStore.OID.test(oid) || !ref?.startsWith("refs/"))
        throw new SnapshotStore.StorageError("Invalid archived reference")
      refs.set(ref, oid)
    }
    return refs
  }

  async function mergeRepository(source: string, target: string) {
    await SnapshotGit.checked(source, ["fsck", "--full"])
    await SnapshotStore.initializeBareRepository(target)
    if (await Bun.file(path.join(target, "objects", "info", "alternates")).exists())
      throw new SnapshotStore.StorageError("Destination snapshot store is not self-contained")
    await SnapshotGit.checked(target, ["fsck", "--full"])
    const incoming = await references(source)
    const existing = await references(target)
    for (const [ref, oid] of incoming) {
      if (existing.has(ref) && existing.get(ref) !== oid)
        throw new SnapshotStore.StorageError("Snapshot references conflict")
    }
    await using catalog = await SnapshotTransfer.Catalog.create(target)
    const imported = await catalog.import(source, { keepToken: "synergy-snapshot-archive" })
    const file = path.join(catalog.directory, "archive-refs")
    const sink = Bun.file(file).writer()
    try {
      let count = 0
      for (const [ref, oid] of incoming) {
        sink.write(`update ${ref} ${oid}\n`)
        if (++count % 1024 === 0) await sink.flush()
      }
    } finally {
      await sink.end()
    }
    if (incoming.size) await SnapshotGit.checked(target, ["update-ref", "--stdin"], { input: file })
    await catalog.protect(undefined, [...incoming.values()])
    await SnapshotGit.checked(target, ["fsck", "--full"])
    await catalog.releaseKeep(imported.keep)
  }

  // An archive is independent of the source home, including legacy alternates.
  // Provenance: https://git-scm.com/docs/git-index-pack (--strict and --keep).
  export async function merge(sourceData: string, targetData: string) {
    if (path.resolve(sourceData) === path.resolve(targetData))
      throw new SnapshotStore.StorageError("Snapshot merge source equals destination")
    const sourceV2 = path.join(sourceData, "snapshot-v2")
    const targetV2 = path.join(targetData, "snapshot-v2")
    for (const directory of [sourceV2, targetV2]) {
      const format = await read(path.join(directory, "format.json"))
      if (format !== undefined) z.object({ version: z.literal(2) }).parse(format)
    }
    for (const scope of await SnapshotRecords.entries(sourceV2)) {
      if (!scope.isDirectory() || scope.name.startsWith(".")) continue
      SnapshotStore.component(scope.name)
      const from = path.join(sourceV2, scope.name)
      const to = path.join(targetV2, scope.name)
      const owners = new Map<string, z.infer<typeof SnapshotStore.Owner>>()
      for (const entry of await SnapshotRecords.entries(path.join(from, "owners"))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        SnapshotStore.component(entry.name.slice(0, -5))
        const incoming = SnapshotStore.Owner.parse(await read(path.join(from, "owners", entry.name)))
        const value = await read(path.join(to, "owners", entry.name))
        const existing = value === undefined ? undefined : SnapshotStore.Owner.parse(value)
        if (existing && existing.backend !== incoming.backend)
          throw new SnapshotStore.StorageError(
            "Snapshot owner backends conflict; migrate or resolve deleted sessions before merging",
          )
        owners.set(entry.name, incoming)
      }
      const marker = await read(path.join(from, "repository.json"))
      if (marker !== undefined) z.object({ version: z.literal(2), objectFormat: z.literal("sha1") }).parse(marker)
      if (await Bun.file(path.join(from, "store.git", "HEAD")).exists()) {
        await mergeRepository(path.join(from, "store.git"), path.join(to, "store.git"))
        await write(path.join(to, "repository.json"), { version: 2, objectFormat: "sha1" })
      } else if (marker !== undefined || [...owners.values()].some((owner) => owner.backend === "shared"))
        throw new SnapshotStore.StorageError("Archive is missing its shared snapshot object store")
      for (const directory of ["migrations", "deletions"])
        await copyMetadata(path.join(from, directory), path.join(to, directory))
      for (const [name, owner] of owners) await write(path.join(to, "owners", name), owner)
    }
    for (const scope of await SnapshotRecords.entries(path.join(sourceData, "snapshot"))) {
      if (!scope.isDirectory()) continue
      const sourceScope = path.join(sourceData, "snapshot", scope.name)
      if (await Bun.file(path.join(sourceScope, "HEAD")).exists()) {
        await mergeRepository(sourceScope, path.join(targetData, "snapshot", scope.name))
        continue
      }
      for (const entry of await SnapshotRecords.entries(sourceScope)) {
        if (!entry.isDirectory()) continue
        const from = path.join(sourceScope, entry.name)
        if (!(await Bun.file(path.join(from, "HEAD")).exists())) continue
        const to = path.join(targetData, "snapshot", scope.name, entry.name)
        await mergeRepository(from, to)
        if (!entry.name.startsWith(".") && !scope.name.startsWith(".")) {
          SnapshotStore.component(entry.name)
          const owner = path.join(targetV2, scope.name, "owners", entry.name + ".json")
          if ((await read(owner)) === undefined) await write(owner, { version: 2, backend: "legacy" })
        }
      }
    }
  }
}
