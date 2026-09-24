import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { withFileLock } from "./fs-lock"

export async function identifyFilesystemObject(filename: string) {
  const stat = await fs.stat(filename, { bigint: true })
  const directory = stat.isDirectory()
  const overlay =
    directory && process.platform === "linux" && (await fs.statfs(filename, { bigint: true })).type === 0x794c7630n
  // OverlayFS copy-up replaces lower metadata, including birthtime, while preserving the directory.
  // Provenance: https://docs.kernel.org/filesystems/overlayfs.html#directories
  // Local adaptation: bind overlay directories to their mount device/inode rather than the backing layer's birthtime.
  return {
    directory,
    physicalID: overlay ? `overlay:${stat.dev}:${stat.ino}` : `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
  }
}

export async function identifyDirectory(directory: string, allowMissing = false) {
  const absolute = path.resolve(directory)
  try {
    const canonical = await fs.realpath(absolute)
    const identity = await identifyFilesystemObject(canonical)
    if (!identity.directory)
      throw Object.assign(new Error("Workspace location is not a directory"), { code: "ENOTDIR" })
    return { path: canonical, physicalID: identity.physicalID }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: absolute, physicalID: undefined }
    throw error
  }
}

export async function readOrCreateIdentityFile(filename: string): Promise<string> {
  return withFileLock(
    { directory: path.join(path.dirname(filename), ".locks"), key: path.basename(filename) },
    async () => {
      const existing = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (existing !== undefined) {
        if (!/^[0-9a-f-]{36}$/.test(existing)) throw new Error("Invalid local filesystem namespace identity")
        return existing
      }
      const identity = randomUUID()
      const handle = await fs.open(filename, "wx", 0o600)
      try {
        await handle.writeFile(identity)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return identity
    },
  )
}
