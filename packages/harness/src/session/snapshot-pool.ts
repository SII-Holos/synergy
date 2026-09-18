import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotTransfer } from "./snapshot-transfer"

export namespace SnapshotPool {
  export function repository(dataRoot: string, scopeID: string) {
    return path.join(dataRoot, "snapshot", SnapshotStore.component(scopeID), ".shared.old")
  }

  function alternate(source: string, target: string) {
    return path.relative(path.join(source, "objects"), path.join(target, "objects")).split(path.sep).join("/") + "\n"
  }

  async function* localObjects(source: string) {
    const objects = path.join(source, "objects")
    for (const prefix of await fs.readdir(objects, { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue
      const directory = path.join(objects, prefix.name)
      if (/^[0-9a-f]{2}$/.test(prefix.name)) {
        for await (const entry of await fs.opendir(directory))
          if (entry.isFile() && /^[0-9a-f]{38}$/.test(entry.name)) yield path.join(directory, entry.name)
      } else if (prefix.name === "pack") {
        for await (const entry of await fs.opendir(directory))
          if (entry.isFile() && /^pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)$/.test(entry.name))
            yield path.join(directory, entry.name)
      }
    }
  }

  export async function pending(source: string, target: string) {
    if (!(await Bun.file(path.join(source, "HEAD")).exists())) return false
    const current = await Bun.file(path.join(source, "objects", "info", "alternates"))
      .text()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (current !== alternate(source, target)) return true
    if (!(await Bun.file(path.join(target, "HEAD")).exists())) return true
    for await (const _ of localObjects(source)) return true
    const packs = path.join(target, "objects", "pack")
    for (const entry of await fs.readdir(packs)) {
      if (!/^pack-[0-9a-f]{40}\.keep$/.test(entry)) continue
      if ((await Bun.file(path.join(packs, entry)).text()).trim() === "synergy-legacy-pool") return true
    }
    return false
  }

  async function syncDirectory(directory: string) {
    if (process.platform === "win32") return
    const file = await fs.open(directory, "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }

  export async function consolidate(source: string, catalog: SnapshotTransfer.Catalog, signal?: AbortSignal) {
    const target = catalog.target
    if (
      path.resolve(source) === path.resolve(target) ||
      path.resolve(target).startsWith(path.resolve(source) + path.sep)
    )
      throw new SnapshotStore.StorageError("Shared snapshot storage must be independent of its legacy pool")
    for (const directory of [source, target].flatMap((repo) => [
      repo,
      path.join(repo, "objects"),
      path.join(repo, "objects", "info"),
      path.join(repo, "objects", "pack"),
    ])) {
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new SnapshotStore.StorageError("Snapshot pool directories must be local directories")
    }
    await SnapshotStore.assertStandalone(target)
    await SnapshotGit.checked(source, ["fsck", "--full"], { signal })
    const trees: string[] = []
    for await (const line of SnapshotGit.lines(source, ["for-each-ref", "--format=%(objectname) %(objecttype)"], {
      signal,
    })) {
      const [oid, type] = line.split(" ")
      if (type === "tree") trees.push(oid)
    }
    const imported = await catalog.import(source, { requiredTrees: trees, signal, keepToken: "synergy-legacy-pool" })
    await catalog.protect(undefined, [], signal, { packReferences: true })
    await SnapshotGit.checked(target, ["fsck", "--full"], { signal })
    const file = path.join(source, "objects", "info", "alternates")
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(alternate(source, target))
        await handle.sync()
      } finally {
        await handle.close()
      }
      signal?.throwIfAborted()
      // Provenance: https://git-scm.com/docs/gitrepository-layout (objects/info/alternates).
      // Keep the legacy path for unowned borrowers; publish its durable redirect before removing local copies.
      await fs.rename(temporary, file)
      await syncDirectory(path.dirname(file))
      await syncDirectory(path.join(source, "objects"))
    } finally {
      await fs.rm(temporary, { force: true })
    }
    let removedBytes = 0
    for await (const object of localObjects(source)) {
      signal?.throwIfAborted()
      const stat = await fs.stat(object)
      await fs.rm(object)
      removedBytes += stat.blocks * 512
    }
    await syncDirectory(path.join(source, "objects"))
    await SnapshotTransfer.releaseKeeps(target, "synergy-legacy-pool")
    return { objectsAdded: imported.added, removedBytes }
  }
}
