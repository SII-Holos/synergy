import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export namespace SnapshotPath {
  export async function temporary() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sy-snapshot-"))
    await fs.chmod(directory, 0o700)
    return {
      directory,
      async [Symbol.asyncDispose]() {
        await fs.rm(directory, { recursive: true, force: true })
      },
    }
  }

  export async function repository(args: string[]) {
    const offset = args.indexOf("--git-dir")
    const repo = args[offset + 1]
    if (process.platform !== "win32" || offset < 0 || !repo || path.resolve(repo).length < 200)
      return { args, async [Symbol.asyncDispose]() {} }
    const temporary = await SnapshotPath.temporary()
    try {
      const alias = path.join(temporary.directory, "repo")
      // Provenance: https://github.com/git-for-windows/git/blob/main/setup.c
      // Existing bare stores support a short junction; startup rejects a long
      // explicit GIT_DIR before core.longpaths can govern object/ref access.
      await fs.symlink(path.resolve(repo), alias, "junction")
      const result = [...args]
      result[offset + 1] = alias
      return { args: result, [Symbol.asyncDispose]: () => temporary[Symbol.asyncDispose]() }
    } catch (error) {
      await temporary[Symbol.asyncDispose]()
      throw error
    }
  }

  export async function exists(filename: string) {
    return fs.stat(filename).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
        throw error
      },
    )
  }
}
