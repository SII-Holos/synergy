import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "../storage/atomic-file"
import { StorageIntegrityError } from "../storage/errors"

const Protection = z.object({ version: z.literal(1), backupID: z.string(), dev: z.number(), ino: z.number() }).strict()
const filename = (dataRoot: string) => path.join(dataRoot, "storage", "snapshot-protection.json")

export namespace SnapshotProtection {
  export async function protect(dataRoot: string, backupID: string) {
    const directory = path.join(dataRoot, "snapshot")
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new StorageIntegrityError("Legacy snapshots require a local directory")
    const current = await read(dataRoot)
    const value = { version: 1 as const, backupID, dev: stat.dev, ino: stat.ino }
    if (current && JSON.stringify(current) !== JSON.stringify(value))
      throw new StorageIntegrityError("Protected snapshot identity changed")
    await AtomicFile.writeJsonAtomic(filename(dataRoot), JSON.stringify(value), { private: true, durable: true })
  }

  async function read(dataRoot: string) {
    try {
      return Protection.parse(JSON.parse(await fs.readFile(filename(dataRoot), "utf8")))
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }

  export async function active(dataRoot: string) {
    const saved = await read(dataRoot)
    if (!saved) return false
    const stat = await fs.lstat(path.join(dataRoot, "snapshot"))
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== saved.dev || stat.ino !== saved.ino)
      throw new StorageIntegrityError("Protected snapshot source was replaced")
    return true
  }

  export async function release(dataRoot: string, backupID: string) {
    const saved = await read(dataRoot)
    if (!saved) return
    if (saved.backupID !== backupID) throw new StorageIntegrityError("Snapshot backup identity changed before release")
    await active(dataRoot)
    await fs.rm(filename(dataRoot))
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(filename(dataRoot)), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  }

  export async function assertWritable(dataRoot: string) {
    if (await active(dataRoot))
      throw new StorageIntegrityError("Legacy snapshot sources are protected until their upgrade backup is complete")
  }
}
