import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Filesystem } from "@ericsanchezok/synergy-harness/util/filesystem"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceFileImport } from "@ericsanchezok/synergy-harness/workspace/file-import"

export namespace BrowserExport {
  type Workspace = NonNullable<ReturnType<typeof ScopeContext.tryWorkspace>>

  export function capture(): Workspace {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id || !workspace.generation) throw new Error("Browser export requires a bound Workspace")
    return structuredClone(workspace)
  }

  export async function fileTarget(workspace: string, input: string): Promise<string> {
    const lexicalWorkspace = path.resolve(workspace)
    const requested = path.resolve(lexicalWorkspace, input)
    if (requested === lexicalWorkspace || !Filesystem.contains(lexicalWorkspace, requested))
      throw new Error("Browser export path must be inside the workspace.")
    const realWorkspace = await fs.realpath(lexicalWorkspace)
    const relativeParent = path.relative(lexicalWorkspace, path.dirname(requested))
    let current = realWorkspace
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error("Browser export parent directory is unsafe.")
    }
    return path.join(current, path.basename(requested))
  }

  export async function copy(
    workspace: Workspace,
    input: string,
    source: string,
    signal?: AbortSignal,
    validateSource?: (file: string) => Promise<void>,
  ) {
    const scope = ScopeContext.current.scope
    if (workspace.scopeID !== scope.id) throw new Error("Browser export belongs to another Scope")
    return WorkspaceAccess.withinTask(async () => {
      await WorkspaceAccess.use([workspace])
      return ScopeContext.provide({
        scope,
        workspace,
        async fn() {
          const target = await fileTarget(workspace.path, input)
          await WorkspaceFileImport.apply(
            {
              from: source,
              to: target,
              async validateSource(file) {
                const info = await fs.lstat(file)
                if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
                  throw new Error("Browser export source is unsafe")
                await validateSource?.(file)
              },
            },
            signal,
          )
          return target
        },
      })
    }, signal)
  }

  export async function writeFile(
    workspace: Workspace,
    input: string,
    content: string | Uint8Array,
    signal?: AbortSignal,
  ) {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-export-"))
    try {
      signal?.throwIfAborted()
      const source = path.join(staging, "file")
      await fs.writeFile(source, content, { flag: "wx", mode: 0o600 })
      return await copy(workspace, input, source, signal)
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  export async function bundle(
    workspace: Workspace,
    input: string,
    populate: (directory: string) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-bundle-"))
    try {
      signal?.throwIfAborted()
      await populate(staging)
      signal?.throwIfAborted()
      return await copy(workspace, input, staging, signal)
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }
}
