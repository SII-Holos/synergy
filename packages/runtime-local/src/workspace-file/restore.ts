import path from "node:path"
import { SnapshotRestore } from "@ericsanchezok/synergy-harness/session/snapshot-restore"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { SensitivePathPolicy } from "@ericsanchezok/synergy-harness/enforcement/sensitive-path"
import { FileEntry } from "../file/entry"
import { FileMutation } from "../file/mutation"
import { FileWatcherEvent } from "../file/watcher-event"
import { WorkspaceFileIndexer } from "./indexer"
import { WorkspaceFileStatus } from "./status"

export namespace WorkspaceFileRestore {
  async function validate(file: SnapshotRestore.File) {
    const binding = await WorkspaceBinding.validate(
      file.workspace.id,
      ScopeContext.current.scope.id,
      file.workspace.generation,
    )
    if (binding.path !== file.workspace.root) throw new FileMutation.ConflictError()
    const target = await FileEntry.canonical(file.file)
    const relative = path.relative(binding.path, target)
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new FileMutation.AccessDeniedError("Historical file is outside its Workspace")
    if (
      relative.split(path.sep).some((segment) => segment === ".git" || segment === ".synergy") ||
      SensitivePathPolicy.classify(relative, { mode: "write", workspaceRoot: binding.path }).matched
    )
      throw new FileMutation.AccessDeniedError("Protected files cannot be restored from a snapshot")
    return binding
  }

  export async function restore(
    input: Parameters<SnapshotRestore.Host["restore"]>[0],
  ): Promise<SnapshotRestore.Result> {
    if (input.files.length > 10_000) throw new FileEntry.LimitError("Restore exceeds 10,000 files")
    const before = new Map<string, { entry: FileEntry.Entry | null; contentVersion?: string }>()
    const bindings = new Map<string, Awaited<ReturnType<typeof validate>>>()
    for (const file of input.files) {
      input.signal?.throwIfAborted()
      const binding = await validate(file)
      bindings.set(JSON.stringify([binding.id, binding.generation]), binding)
      const entry = await FileEntry.inspect(file.file)
      if (entry?.type === "file" && entry.stat.size > 50n * 1024n * 1024n)
        throw new FileEntry.LimitError("A file to restore exceeds 50 MB")
      const content = entry?.type === "file" ? await FileMutation.snapshot(file.file, input.signal) : null
      if ((await FileEntry.inspect(file.file))?.version !== entry?.version) throw new FileMutation.ConflictError()
      before.set(file.file, { entry, contentVersion: content?.version })
    }
    const roots = [...new Set(input.files.map((file) => file.workspace.root))]
    return WorkspaceAccess.task({ workspace: null, signal: input.signal }, async () => {
      await WorkspaceAccess.use([...bindings.values()])
      await WorkspaceAccess.reserveWrite(roots, input.signal)
      const result: SnapshotRestore.Result = { restoredFiles: [], failedFiles: [] }
      for (const file of input.files) {
        let changed = false
        try {
          input.signal?.throwIfAborted()
          const binding = await validate(file)
          const expected = before.get(file.file)!
          if ((await FileEntry.inspect(file.file))?.version !== expected.entry?.version)
            throw new FileMutation.ConflictError()
          if (
            expected.contentVersion &&
            (await FileMutation.snapshot(file.file, input.signal))?.version !== expected.contentVersion
          )
            throw new FileMutation.ConflictError()
          await ScopeContext.provide({
            scope: ScopeContext.current.scope,
            workspace: binding,
            fn: async () => {
              try {
                if (file.mode === null) {
                  if (expected.entry) {
                    if (expected.entry.type === "directory" || expected.entry.type === "unknown")
                      throw new FileMutation.AccessDeniedError(
                        "A directory or special file cannot be removed by file restore",
                      )
                    await FileEntry.remove({
                      path: file.file,
                      expectedVersion: expected.entry.version,
                      signal: input.signal,
                      validate: async () => {
                        await validate(file)
                      },
                    })
                    changed = true
                  }
                } else {
                  const content = await file.read()
                  if (content.byteLength > 50 * 1024 * 1024)
                    throw new FileEntry.LimitError("Historical file exceeds 50 MB")
                  await FileEntry.replace({
                    path: file.file,
                    expectedVersion: expected.entry?.version ?? null,
                    content,
                    mode: file.mode,
                    createParents: true,
                    signal: input.signal,
                    validate: async () => {
                      await validate(file)
                    },
                  })
                  changed = true
                }
              } catch (error) {
                if (error instanceof FileEntry.PartialError) changed = true
                throw error
              } finally {
                if (changed) {
                  WorkspaceFileStatus.invalidate()
                  WorkspaceFileIndexer.invalidate()
                  await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
                    file: path.relative(binding.path, file.file),
                    event: file.mode === null ? "deleted" : "changed",
                    absolute: file.file,
                    resync: true,
                  })
                }
              }
            },
          })
          result.restoredFiles.push(file.file)
        } catch (error) {
          const partial = changed || error instanceof FileEntry.PartialError
          result.failedFiles.push({
            file: file.file,
            code: partial
              ? "partially_restored"
              : input.signal?.aborted
                ? "cancelled"
                : error instanceof FileMutation.ConflictError
                  ? "conflict"
                  : "restore_failed",
            message: partial
              ? "The file changed, but restoration could not be fully confirmed"
              : error instanceof Error
                ? error.message
                : "File restore failed",
          })
        }
      }
      return result
    })
  }
}
