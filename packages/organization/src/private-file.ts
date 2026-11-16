import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export const OrganizationPrivateFileError = NamedError.create(
  "OrganizationPrivateFileError",
  z.object({ message: z.string() }),
)

export async function readOrganizationPrivateFile(filename: string) {
  try {
    if (!path.isAbsolute(filename)) throw new Error()
    const before = await fs.lstat(filename)
    if (!before.isFile() || before.isSymbolicLink() || (process.platform !== "win32" && (before.mode & 0o077) !== 0))
      throw new Error()
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === "win32" ? 0 : constants.O_NONBLOCK),
    )
    try {
      const initial = await handle.stat()
      if (
        !initial.isFile() ||
        initial.ino !== before.ino ||
        initial.dev !== before.dev ||
        (process.platform !== "win32" && (initial.mode & 0o077) !== 0) ||
        initial.size === 0 ||
        initial.size > 64 * 1024
      )
        throw new Error()
      const bytes = Buffer.alloc(initial.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      const after = await handle.stat()
      const retained = await fs.lstat(filename)
      if (
        length !== initial.size ||
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.ctimeMs !== initial.ctimeMs ||
        (process.platform !== "win32" && (after.mode & 0o077) !== 0) ||
        retained.ino !== initial.ino ||
        retained.dev !== initial.dev ||
        retained.size !== initial.size ||
        retained.mtimeMs !== initial.mtimeMs ||
        retained.ctimeMs !== initial.ctimeMs ||
        (process.platform !== "win32" && (retained.mode & 0o077) !== 0) ||
        !retained.isFile() ||
        retained.isSymbolicLink()
      )
        throw new Error()
      return bytes.subarray(0, length).toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    throw new OrganizationPrivateFileError({ message: "Read an unchanged private regular file" })
  }
}
