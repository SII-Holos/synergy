import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { WorkspaceErrors } from "@ericsanchezok/synergy-harness/workspace/errors"

export namespace FileCoordination {
  export const AccessDeniedError = WorkspaceErrors.AccessDeniedError

  export async function canonical(input: string): Promise<string> {
    const absolute = path.resolve(input)
    try {
      return await fs.realpath(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      if (stat?.isSymbolicLink())
        throw new AccessDeniedError("Access denied: a dangling symbolic link cannot be written")
      const parent = path.dirname(absolute)
      if (parent === absolute) throw error
      return path.join(await canonical(parent), path.basename(absolute))
    }
  }

  export async function lockDirectory() {
    // Runtime-specific temporary directories must not split native exclusion on the same host.
    // userInfo reads the OS profile rather than environment overrides: https://nodejs.org/api/os.html#osuserinfooptions
    const directory =
      process.platform === "win32"
        ? path.join(os.userInfo().homedir, ".synergy-file-locks")
        : path.join("/tmp", `synergy-file-locks-${process.getuid!()}`)
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const stat = await fs.lstat(directory)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    )
      throw new AccessDeniedError("Filesystem lock directory has an invalid owner or access mode")
    return directory
  }
}
