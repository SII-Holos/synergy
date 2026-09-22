import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { withFileLock } from "./fs-lock"

export async function identifyDirectory(directory: string, allowMissing = false) {
  const absolute = path.resolve(directory)
  try {
    const canonical = await fs.realpath(absolute)
    const stat = await fs.stat(canonical, { bigint: true })
    if (!stat.isDirectory())
      throw Object.assign(new Error("Workspace location is not a directory"), { code: "ENOTDIR" })
    return { path: canonical, physicalID: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }
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
