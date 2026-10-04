import path from "node:path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
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
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { FileView } from "../file/view"
import { randomUUID } from "node:crypto"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { SnapshotLink } from "@ericsanchezok/synergy-harness/session/snapshot-link"

export namespace WorkspaceFileRestore {
  function previewFile(
    file: SnapshotRestore.File,
    version: SnapshotRestore.PreviewFile["version"],
    before: Uint8Array,
    after: Uint8Array,
    limit: number,
  ): SnapshotRestore.PreviewFile {
    const binary = before.includes(0) || after.includes(0)
    return {
      file: file.file,
      workspace: file.workspace,
      version,
      before: binary ? "" : new TextDecoder().decode(before.subarray(0, limit)),
      after: binary ? "" : new TextDecoder().decode(after.subarray(0, limit)),
      action: file.mode === null ? "delete" : version.entry === null ? "create" : "replace",
      truncated: before.length > limit || after.length > limit,
      binary,
    }
  }

  export async function preview(
    input: Parameters<SnapshotRestore.Host["restore"]>[0],
  ): Promise<SnapshotRestore.PreviewFile[]> {
    if (input.files.length > 10_000) throw new FileEntry.LimitError("Restore exceeds 10,000 files")
    const rows: SnapshotRestore.PreviewFile[] = []
    let remaining = 4 * 1024 * 1024
    const append = (
      file: SnapshotRestore.File,
      version: SnapshotRestore.PreviewFile["version"],
      before: Uint8Array,
      after: Uint8Array,
    ) => {
      const row = previewFile(file, version, before, after, Math.min(128 * 1024, Math.floor(remaining / 2)))
      remaining = Math.max(0, remaining - Buffer.byteLength(row.before) - Buffer.byteLength(row.after))
      rows.push(row)
    }
    for (const file of input.files) {
      input.signal?.throwIfAborted()
      const target = await file.read()
      const after = file.mode === "120000" ? Buffer.from(SnapshotLink.display(SnapshotLink.decode(target))) : target
      if (file.workspace.pathKind === "workspace") {
        await using resources = await EnvironmentResources.resolve({
          scopeID: ScopeContext.current.scope.id,
          workspaceID: file.workspace.id,
          workspaceGeneration: file.workspace.generation,
          needs: { workspace: true },
          signal: input.signal,
        })
        await EnvironmentResources.provide(resources, `restore-preview:${randomUUID()}`, async () => {
          const entry = await FileView.stat(file.file)
          if (entry && entry.kind !== "file")
            throw new FileMutation.AccessDeniedError("This entry cannot be previewed for restoration")
          const before = entry ? await FileView.bytes(file.file, undefined, 50 * 1024 * 1024) : new Uint8Array()
          if ((await FileView.stat(file.file))?.entryVersion !== entry?.entryVersion)
            throw new FileMutation.ConflictError()
          append(
            file,
            {
              entry: entry?.entryVersion ?? null,
              ...(entry ? { content: `sha256:${WorkspaceTree.hash(before)}` } : {}),
            },
            before,
            after,
          )
        })
        continue
      }
      await validate(file)
      const entry = await FileEntry.inspect(file.file)
      if (entry && entry.type !== "file" && entry.type !== "symlink")
        throw new FileMutation.AccessDeniedError("A directory or special file cannot be restored")
      if (entry && entry.stat.size > 50n * 1024n * 1024n)
        throw new FileEntry.LimitError("A file to restore exceeds 50 MB")
      const before =
        entry?.type === "file"
          ? await previewBytes(file.file, entry, input.signal)
          : entry?.link
            ? Buffer.from(SnapshotLink.display({ target: entry.link }))
            : new Uint8Array()
      if ((await FileEntry.inspect(file.file))?.version !== entry?.version) throw new FileMutation.ConflictError()
      append(
        file,
        {
          entry: entry?.version ?? null,
          ...(entry?.type === "file" ? { content: `sha256:${WorkspaceTree.hash(before)}` } : {}),
        },
        before,
        after,
      )
    }
    return rows
  }

  async function previewBytes(filename: string, expected: FileEntry.Entry, signal?: AbortSignal) {
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      const stat = await handle.stat({ bigint: true })
      if (
        !stat.isFile() ||
        stat.dev !== expected.stat.dev ||
        stat.ino !== expected.stat.ino ||
        stat.size !== expected.stat.size ||
        stat.ctimeNs !== expected.stat.ctimeNs
      )
        throw new FileMutation.ConflictError()
      const bytes = Buffer.alloc(Number(stat.size))
      let offset = 0
      while (offset < bytes.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
        if (!bytesRead) throw new FileMutation.ConflictError()
        offset += bytesRead
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  function checkVersion(file: SnapshotRestore.File, entry: string | null, content?: string) {
    if (file.expected && (file.expected.entry !== entry || file.expected.content !== content))
      throw new FileMutation.ConflictError()
  }

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
    if (input.files.some((file) => file.workspace.pathKind === "workspace")) {
      const portable = input.files.filter((file) => file.workspace.pathKind === "workspace")
      const native = input.files.filter((file) => file.workspace.pathKind !== "workspace")
      const result = await restoreContent({ ...input, files: portable })
      if (native.length) {
        try {
          const other = await restore({ ...input, files: native })
          result.restoredFiles.push(...other.restoredFiles)
          result.failedFiles.push(...other.failedFiles)
        } catch (error) {
          result.failedFiles.push(
            ...native.map((file) => ({
              file: file.file,
              code: input.signal?.aborted
                ? "cancelled"
                : error instanceof FileMutation.ConflictError
                  ? "conflict"
                  : "restore_failed",
              message: error instanceof Error ? error.message : "File restoration failed",
            })),
          )
        }
      }
      return result
    }
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
      checkVersion(file, entry?.version ?? null, content?.version)
      if ((await FileEntry.inspect(file.file))?.version !== entry?.version) throw new FileMutation.ConflictError()
      before.set(file.file, { entry, contentVersion: content?.version })
    }
    const roots = [...new Set(input.files.map((file) => path.dirname(file.file)))]
    return WorkspaceAccess.task({ workspace: null, signal: input.signal }, async () => {
      await WorkspaceAccess.use([...bindings.values()])
      return WorkspaceAccess.write(
        roots,
        async () => {
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
        },
        input.signal,
      )
    })
  }

  async function restoreContent(
    input: Parameters<SnapshotRestore.Host["restore"]>[0],
  ): Promise<SnapshotRestore.Result> {
    const result: SnapshotRestore.Result = { restoredFiles: [], failedFiles: [] }
    const groups = Map.groupBy(input.files, (file) => JSON.stringify([file.workspace.id, file.workspace.generation]))
    for (const files of groups.values()) {
      const source = files[0]!.workspace
      const processed = new Set<SnapshotRestore.File>()
      try {
        await using resources = await EnvironmentResources.resolve({
          scopeID: ScopeContext.current.scope.id,
          workspaceID: source.id,
          workspaceGeneration: source.generation,
          needs: { workspace: true },
          signal: input.signal,
        })
        await WorkspaceState.provide(
          { id: source.id, scopeID: ScopeContext.current.scope.id, generation: source.generation },
          () =>
            EnvironmentResources.provide(resources, `restore:${randomUUID()}`, async () => {
              const original =
                resources.kind === "objects"
                  ? await WorkspaceCatalog.get(source.id, ScopeContext.current.scope.id)
                  : undefined
              const tree = original
                ? await WorkspaceContent.manifest(
                    original,
                    (await WorkspaceContent.resolve({ workspaceID: source.id, scopeID: original.scopeID })).store,
                  )
                : undefined
              let revision = original?.content?.revision ?? 0
              const before = new Map<string, { entry: Awaited<ReturnType<typeof FileView.stat>>; version?: string }>()
              for (const file of files) {
                WorkspaceTree.Path.parse(file.file)
                if (
                  file.file.split("/").some((segment) => segment === ".git" || segment === ".synergy") ||
                  SensitivePathPolicy.classifyRelative(file.file).matched
                )
                  throw new FileMutation.AccessDeniedError("Protected files cannot be restored from a snapshot")
                const entry = await FileView.stat(file.file)
                if (entry && entry.kind !== "file" && entry.kind !== "symlink")
                  throw new FileMutation.AccessDeniedError("A directory or special file cannot be restored")
                const version =
                  entry?.kind === "file"
                    ? `sha256:${WorkspaceTree.hash(await FileView.bytes(file.file, undefined, 50 * 1024 * 1024))}`
                    : undefined
                checkVersion(file, entry?.entryVersion ?? null, version)
                if ((await FileView.stat(file.file))?.entryVersion !== entry?.entryVersion)
                  throw new FileMutation.ConflictError()
                before.set(file.file, { entry, version })
              }
              for (const file of files) {
                try {
                  input.signal?.throwIfAborted()
                  const expected = before.get(file.file)!
                  let expectedVersion = expected.entry?.entryVersion ?? null
                  if (original && tree) {
                    if ((await WorkspaceCatalog.get(source.id, original.scopeID)).content?.revision !== revision)
                      throw new FileMutation.ConflictError()
                    const entry = WorkspaceTree.resolve(tree, file.file, false).entry
                    if (
                      (entry ? WorkspaceTree.entryVersion(entry, original.content?.revision) : null) !== expectedVersion
                    )
                      throw new FileMutation.ConflictError()
                    expectedVersion = entry ? WorkspaceTree.entryVersion(entry, revision) : null
                  }
                  if (file.mode === null) {
                    if (expected.entry)
                      await FileView.mutate(
                        { kind: "remove", path: file.file, expectedVersion: expectedVersion! },
                        input.signal,
                        true,
                      )
                  } else {
                    const bytes = await file.read()
                    await FileView.mutate(
                      {
                        kind: "replace",
                        path: file.file,
                        mode: file.mode,
                        data: Buffer.from(bytes).toString("base64"),
                        expectedVersion,
                        expectedContentVersion: expected.version,
                      },
                      input.signal,
                      true,
                    )
                  }
                  if (original && (file.mode !== null || expected.entry)) revision++
                  WorkspaceFileStatus.invalidate()
                  WorkspaceFileIndexer.invalidate()
                  await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
                    file: file.file,
                    event: file.mode === null ? "deleted" : "changed",
                    resync: true,
                  })
                  result.restoredFiles.push(file.file)
                  processed.add(file)
                } catch (error) {
                  processed.add(file)
                  result.failedFiles.push({
                    file: file.file,
                    code: input.signal?.aborted
                      ? "cancelled"
                      : error instanceof FileMutation.ConflictError
                        ? "conflict"
                        : "restore_failed",
                    message: error instanceof Error ? error.message : "File restore failed",
                  })
                }
              }
            }),
        )
      } catch (error) {
        for (const file of files)
          if (!processed.has(file))
            result.failedFiles.push({
              file: file.file,
              code: "restore_failed",
              message: error instanceof Error ? error.message : "File restore failed",
            })
      }
    }
    return result
  }
}
