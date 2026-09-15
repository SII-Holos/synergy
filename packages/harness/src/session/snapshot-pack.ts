import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { SnapshotGit } from "./snapshot-git"

export namespace SnapshotPack {
  export async function loose(repository: string, options: { apply?: boolean; signal?: AbortSignal } = {}) {
    const objects = path.join(repository, "objects")
    for (const directory of [objects, path.join(objects, "pack")]) {
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error("Snapshot object directories must be local directories")
    }
    const directory = options.apply ? await fs.mkdtemp(path.join(repository, "synergy-pack-")) : undefined
    let db: Database | undefined
    try {
      if (directory) {
        initializeSqliteEngine()
        db = new Database(path.join(directory, "inventory.sqlite"))
        db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE missing (oid TEXT PRIMARY KEY)")
      }
      const insert = db?.prepare("INSERT INTO missing VALUES (?)")
      let count = 0
      let allocatedBytes = 0
      let bytes = 0
      for (const prefix of await fs.readdir(objects, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue
        const entries = await fs.opendir(path.join(objects, prefix.name))
        for await (const entry of entries) {
          options.signal?.throwIfAborted()
          if (!entry.isFile() || !/^[0-9a-f]{38}$/.test(entry.name)) continue
          const stat = await fs.stat(path.join(objects, prefix.name, entry.name))
          insert?.run(prefix.name + entry.name)
          count++
          bytes += stat.size
          allocatedBytes += stat.blocks * 512
        }
      }
      const before = { objects: count, bytes, allocatedBytes }
      if (!directory || !db || !count) return { applied: false, packedObjects: 0, before, packBytes: 0, freedBytes: 0 }
      const input = path.join(directory, "objects")
      const writer = Bun.file(input).writer()
      try {
        let written = 0
        for (const row of db.query<{ oid: string }, []>("SELECT oid FROM missing ORDER BY oid").iterate()) {
          writer.write(row.oid + "\n")
          if (++written % 1024 === 0) await writer.flush()
        }
      } finally {
        await writer.end()
      }
      await fs.mkdir(path.join(objects, "pack"), { recursive: true, mode: 0o700 })
      // Provenance: https://git-scm.com/docs/git-pack-objects and https://git-scm.com/docs/git-prune-packed
      // Pack all local loose IDs, including unreferenced evidence, in staging. Publish only after complete
      // verification, then remove loose duplicates; alternate stores and existing packs stay untouched.
      const hash = await SnapshotGit.checked(
        repository,
        ["pack-objects", "--non-empty", "--threads=2", path.join(directory, "pack")],
        { ...options, input },
      )
      if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error("Snapshot packing did not return a valid pack identity")
      const staged = path.join(directory, "pack-" + hash)
      await SnapshotGit.checked(repository, ["verify-pack", staged + ".idx"], options)
      const covered = db.prepare("DELETE FROM missing WHERE oid = ?")
      for await (const line of SnapshotGit.lines(repository, ["verify-pack", "-v", staged + ".idx"], options)) {
        const oid = line.split(" ")[0]
        if (/^[0-9a-f]{40}$/.test(oid)) covered.run(oid)
      }
      if (db.query("SELECT 1 FROM missing LIMIT 1").get())
        throw new Error("Verified snapshot pack omitted a loose object")
      const pack = path.join(objects, "pack", "pack-" + hash)
      for (const suffix of [".pack", ".idx"]) {
        await fs.chmod(staged + suffix, 0o600)
        const file = await fs.open(staged + suffix, "r+")
        try {
          await file.sync()
        } finally {
          await file.close()
        }
        await fs.link(staged + suffix, pack + suffix).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        })
      }
      await SnapshotGit.checked(repository, ["verify-pack", pack + ".idx"], options)
      if (process.platform !== "win32") {
        const parent = await fs.open(path.dirname(pack), "r")
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      }
      await SnapshotGit.checked(repository, ["prune-packed"], options)
      const stats = await Promise.all([fs.stat(pack + ".pack"), fs.stat(pack + ".idx")])
      const packBytes = stats.reduce((sum, stat) => sum + stat.blocks * 512, 0)
      return {
        applied: true,
        packedObjects: count,
        before,
        packBytes,
        freedBytes: Math.max(0, allocatedBytes - packBytes),
      }
    } finally {
      db?.close()
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
