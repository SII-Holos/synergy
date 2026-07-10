import fs from "node:fs/promises"
import path from "node:path"
import { Filesystem } from "../util/filesystem.js"

export namespace BrowserExport {
  export async function fileTarget(workspace: string, input: string): Promise<string> {
    const lexicalWorkspace = path.resolve(workspace)
    const requested = path.resolve(lexicalWorkspace, input)
    if (!Filesystem.contains(lexicalWorkspace, requested)) {
      throw new Error("Browser export path must be inside the workspace.")
    }
    const realWorkspace = await fs.realpath(lexicalWorkspace)
    const relativeParent = path.relative(lexicalWorkspace, path.dirname(requested))
    const realParent = await ensureContainedParent(realWorkspace, relativeParent)
    return path.join(realParent, path.basename(requested))
  }

  export async function createDirectory(workspace: string, input: string): Promise<string> {
    const target = await fileTarget(workspace, input)
    await fs.mkdir(target, { recursive: false, mode: 0o700 })
    const info = await fs.lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser export directory is unsafe.")
    const [realWorkspace, realTarget] = await Promise.all([fs.realpath(workspace), fs.realpath(target)])
    if (!Filesystem.contains(realWorkspace, realTarget)) {
      throw new Error("Browser export directory escapes the workspace through a symbolic link.")
    }
    return realTarget
  }
}

async function ensureContainedParent(workspace: string, relative: string): Promise<string> {
  let current = workspace
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const candidate = path.join(current, segment)
    let info: Awaited<ReturnType<typeof fs.lstat>>
    try {
      info = await fs.lstat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await fs.mkdir(candidate, { mode: 0o700 })
      info = await fs.lstat(candidate)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Browser export parent directory is unsafe.")
    }
    current = await fs.realpath(candidate)
    if (!Filesystem.contains(workspace, current)) {
      throw new Error("Browser export path escapes the workspace through a symbolic link.")
    }
  }
  return current
}
