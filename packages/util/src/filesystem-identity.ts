import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { withFileLock } from "./fs-lock"

type ObjectStat = { dev: bigint; ino: bigint; birthtimeNs: bigint }
type VolumeIdentity = (filename: string) => string | undefined | Promise<string | undefined>

export function filesystemObjectID(stat: ObjectStat, volume?: string) {
  return volume ? `volume-v1:${volume}:${stat.ino}:${stat.birthtimeNs}` : `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

export async function identifyFilesystemObject(filename: string, volumeIdentity?: VolumeIdentity) {
  const stat = await fs.stat(filename, { bigint: true })
  const directory = stat.isDirectory()
  const overlay =
    directory && process.platform === "linux" && (await fs.statfs(filename, { bigint: true })).type === 0x794c7630n
  // OverlayFS copy-up replaces lower metadata, including birthtime, while preserving the directory.
  // Provenance: https://docs.kernel.org/filesystems/overlayfs.html#directories
  // Local adaptation: bind overlay directories to their mount device/inode rather than the backing layer's birthtime.
  const legacyPhysicalID = overlay ? `overlay:${stat.dev}:${stat.ino}` : filesystemObjectID(stat)
  const volume = !overlay && (await volumeIdentity?.(filename))
  if (!volume) return { directory, physicalID: legacyPhysicalID, legacyPhysicalID: undefined }
  const current = await fs.stat(filename, { bigint: true })
  if (filesystemObjectID(current) !== filesystemObjectID(stat))
    throw new Error("Filesystem object changed during identity inspection")
  return { directory, physicalID: filesystemObjectID(stat, volume), legacyPhysicalID }
}

export async function identifyDirectory(directory: string, allowMissing = false, volumeIdentity?: VolumeIdentity) {
  const absolute = path.resolve(directory)
  try {
    const canonical = await fs.realpath(absolute)
    const identity = await identifyFilesystemObject(canonical, volumeIdentity)
    if (!identity.directory)
      throw Object.assign(new Error("Workspace location is not a directory"), { code: "ENOTDIR" })
    return { path: canonical, physicalID: identity.physicalID, legacyPhysicalID: identity.legacyPhysicalID }
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
