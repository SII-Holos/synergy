import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { FileMutation } from "../file/mutation"
import { FileEntry } from "../file/entry"
import { FileWatcherEvent } from "../file/watcher-event"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceFileIndexer } from "./indexer"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { WorkspaceFileStream } from "./stream"
import { fileURLToPath } from "url"
import fs from "fs/promises"
import path from "path"
import { FileView } from "../file/view"
import { FileIgnore } from "../file/ignore"
import { WorkspaceFile } from "./types"
import { WorkspaceFileRead, likelyBinaryByExtension } from "./read"
import { WorkspaceFileStatus } from "./status"
import { isPathContained } from "@ericsanchezok/synergy-harness/util/path-contain"
import { SensitivePathPolicy } from "@ericsanchezok/synergy-harness/enforcement/sensitive-path"
import os from "node:os"
import { NativeFileEntry } from "../file/entry-core"
import { NativeWorkspaceTree } from "../workspace/tree"

const DEFAULT_CHILDREN_LIMIT = 200
const NODE_CONCURRENCY = 16
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function root() {
  return FileView.directory()
}

function normalizeSlashes(input: string) {
  return input.replaceAll("\\", "/")
}

function stripFileProtocol(input: string) {
  if (!input.startsWith("file://")) return input
  return fileURLToPath(input)
}

function isControlPath(input: string) {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f]/.test(input)
}

function displayRelative(input: string) {
  if (!FileView.native()) return FileView.relative(input)
  const rel = normalizeSlashes(path.relative(root(), input))
  return rel === "." ? "" : rel
}

function hiddenPath(relativePath: string) {
  return normalizeSlashes(relativePath)
    .split("/")
    .some((part) => part.startsWith(".") && part.length > 1)
}

export namespace WorkspaceFileService {
  export const AccessDeniedError = FileMutation.AccessDeniedError
  export const WriteConflictError = FileMutation.ConflictError
  export const PartialMutationError = FileEntry.PartialError
  export const EntryLimitError = FileEntry.LimitError
  export class InvalidContentError extends Error {
    override name = "WorkspaceFileInvalidContentError"
  }
  export class NotFoundError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "WorkspaceFileNotFoundError"
    }
  }

  export const TooLargeError = WorkspaceFileStream.TooLargeError

  export function resolve(input = "", options?: { followFinalSymlink?: boolean }) {
    if (isControlPath(input)) throw new AccessDeniedError("Path contains control characters")
    const cleaned = stripFileProtocol(input)
    if (!FileView.native()) {
      try {
        return FileView.resolve(cleaned)
      } catch {
        throw new AccessDeniedError("Access denied: path escapes workspace")
      }
    }
    const workspace = root()
    const absolute = path.resolve(workspace, cleaned || ".")
    if (!isPathContained(workspace, absolute, options)) {
      throw new AccessDeniedError("Access denied: path escapes workspace")
    }
    return absolute
  }

  export function relative(input: string) {
    if (!FileView.native()) {
      try {
        return FileView.relative(input)
      } catch {
        throw new AccessDeniedError("Access denied: path escapes workspace")
      }
    }
    const absolute = path.isAbsolute(input) ? path.resolve(input) : resolve(input)
    if (!isPathContained(root(), absolute, { followFinalSymlink: false }))
      throw new AccessDeniedError("Access denied: path escapes workspace")
    return displayRelative(absolute)
  }

  export async function assertRealpathInside(absolute: string) {
    if (!FileView.native()) {
      await FileView.canonical(absolute)
      return
    }
    const [real, realRoot] = await Promise.all([FileMutation.canonical(absolute), fs.realpath(root())])
    if (!isPathContained(realRoot, real)) throw new AccessDeniedError("Access denied: real path escapes workspace")
  }

  export function isIgnored(relativePath: string) {
    if (!relativePath) return false
    return FileIgnore.match(relativePath)
  }

  export async function node(
    input: string,
    options?: { resolveGitStatus?: boolean; gitStatus?: WorkspaceFile.GitStatus },
  ): Promise<WorkspaceFile.Node> {
    const absolute = resolve(input, { followFinalSymlink: false })
    await assertEntryInside(absolute)
    const relativePath = displayRelative(absolute)
    const entry = await FileView.stat(absolute)
    if (!entry) throw Object.assign(new NotFoundError("Filesystem entry not found"), { code: "ENOENT" })
    const symlink = entry.kind === "symlink"
    const target = symlink ? await FileView.stat(absolute, true).catch(() => undefined) : entry
    const metadata = target ?? entry
    const type = target?.kind ?? (symlink ? "symlink" : "unknown")
    const mime = Bun.file(absolute).type
    const binary = type === "file" && (mime?.startsWith("text/") ? false : likelyBinaryByExtension(absolute))
    const gitStatus =
      options?.resolveGitStatus === true ? await WorkspaceFileStatus.statusForPath(relativePath) : options?.gitStatus

    return {
      path: relativePath,
      entryVersion: entry.entryVersion,
      name: relativePath ? path.basename(relativePath) : path.basename(root()),
      type,
      size: metadata.size,
      mtime: metadata.mtime,
      ctime: metadata.ctime,
      ignored: isIgnored(relativePath),
      hidden: hiddenPath(relativePath),
      readonly: (metadata.mode & 0o200) === 0,
      symlink,
      binary,
      gitStatus,
    }
  }

  async function assertEntryInside(absolute: string) {
    if (!FileView.native()) {
      await FileView.canonical(absolute, false)
      return
    }
    const [entry, realRoot] = await Promise.all([FileEntry.canonical(absolute), fs.realpath(root())])
    if (!isPathContained(realRoot, entry, { followFinalSymlink: false }))
      throw new AccessDeniedError("Access denied: entry parent escapes workspace")
  }

  async function validateEntry(absolute: string, operation: "read" | "write") {
    await assertEntryInside(absolute)
    if (!FileView.native()) {
      if (!relative(absolute) && operation === "write")
        throw new AccessDeniedError("Access denied: Workspace root cannot be modified")
      assertWritableTarget(absolute)
      assertWritableTarget(await FileView.canonical(absolute, false))
      return
    }
    const [entry, realRoot] = await Promise.all([FileEntry.canonical(absolute), fs.realpath(root())])
    if (entry === realRoot && operation === "write")
      throw new AccessDeniedError("Access denied: Workspace root cannot be modified")
    assertWritableTarget(absolute)
    const match = SensitivePathPolicy.classify(path.relative(realRoot, entry), {
      mode: "write",
      workspaceRoot: realRoot,
    })
    if (match.matched) throw new AccessDeniedError("Access denied: protected filesystem entry")
  }

  async function changedEntry(absolute: string, oldPath?: string) {
    WorkspaceFileStatus.invalidate()
    WorkspaceFileIndexer.invalidate()
    const result = { path: displayRelative(absolute), node: await node(absolute, { resolveGitStatus: false }) }
    try {
      await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
        file: result.path,
        event: oldPath ? "renamed" : "added",
        oldPath: oldPath ? displayRelative(oldPath) : undefined,
        parent: displayRelative(FileView.dirname(absolute)),
        node: result.node,
      })
    } catch (cause) {
      throw new PartialMutationError("Filesystem changed, but publishing the update failed", [absolute], { cause })
    }
    return result
  }
  async function entryOperation<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof PartialMutationError) {
        WorkspaceFileStatus.invalidate()
        WorkspaceFileIndexer.invalidate()
        await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
          file: "",
          event: "changed",
          parent: "",
          resync: true,
        }).catch((cause) => {
          Log.create({ service: "workspace-files" }).warn("partial filesystem update could not be published", {
            error: cause,
          })
        })
      }
      throw error
    }
  }

  export async function createDirectory(input: WorkspaceFile.CreateDirectoryInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const absolute = resolve(input.path, { followFinalSymlink: false })
      await validateEntry(absolute, "write")
      if (FileView.native()) await FileEntry.mkdir({ ...input, path: absolute, signal, validate: validateEntry })
      else
        await FileView.mutate(
          { kind: "mkdir", path: relative(absolute), createParents: input.createParents },
          signal,
          true,
        )
      return changedEntry(absolute)
    })
  }
  export async function move(input: WorkspaceFile.MoveInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const from = resolve(input.from, { followFinalSymlink: false }),
        to = resolve(input.to, { followFinalSymlink: false })
      await validateEntry(from, "write")
      try {
        await validateEntry(to, "write")
        if (FileView.native()) await FileEntry.move({ ...input, from, to, signal, validate: validateEntry })
        else await FileView.mutate({ ...input, kind: "move", from: relative(from), to: relative(to) }, signal, true)
        return await changedEntry(to, from)
      } finally {
        WorkspaceFileStatus.invalidate()
        WorkspaceFileIndexer.invalidate()
      }
    })
  }
  export async function copy(input: WorkspaceFile.CopyInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const from = resolve(input.from, { followFinalSymlink: false }),
        to = resolve(input.to, { followFinalSymlink: false })
      await validateEntry(from, "read")
      await validateEntry(to, "write")
      if (FileView.native()) await FileEntry.copy({ ...input, from, to, signal, validate: validateEntry })
      else await FileView.mutate({ ...input, kind: "copy", from: relative(from), to: relative(to) }, signal, true)
      return changedEntry(to)
    })
  }
  export async function importEntry(
    input: {
      from: string
      to: string
      validateSource: (source: string) => Promise<void>
    },
    signal?: AbortSignal,
  ) {
    const from = await FileEntry.canonical(input.from)
    const source = await FileEntry.inspect(from)
    if (!source) throw new NotFoundError("Import source is unavailable")
    await input.validateSource(from)
    const to = resolve(input.to, { followFinalSymlink: false })
    if (!FileView.native())
      return WorkspaceAccess.withinTask(
        () =>
          entryOperation(async () => {
            await validateEntry(to, "write")
            if (await FileView.stat(to)) throw new WriteConflictError()
            const staging = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-transfer-"))
            await fs.chmod(staging, 0o700)
            try {
              await WorkspaceAccess.write(
                [path.dirname(from)],
                () =>
                  NativeFileEntry.copy({
                    from,
                    to: path.join(staging, "entry"),
                    expectedVersion: source.version,
                    signal,
                    async validate(target, operation) {
                      if (operation === "write") {
                        if (!isPathContained(staging, target, { followFinalSymlink: false }))
                          throw new AccessDeniedError("Transfer staging escaped its owner")
                        return
                      }
                      if (!isPathContained(from, target, { followFinalSymlink: false }))
                        throw new AccessDeniedError("Import source escaped its owner")
                      await input.validateSource(target)
                    },
                  }),
                signal,
              )
              await FileView.importTree(to, (store) => NativeWorkspaceTree.capture(staging, store, signal), signal)
              return await changedEntry(to)
            } finally {
              await fs.rm(staging, { recursive: true, force: true })
            }
          }),
        signal,
      )
    let destinationRoot = path.dirname(to)
    while (!(await FileEntry.inspect(destinationRoot))) destinationRoot = path.dirname(destinationRoot)
    return WorkspaceAccess.withinTask(
      () =>
        entryOperation(() =>
          WorkspaceAccess.write(
            [path.dirname(from), destinationRoot],
            async () => {
              await validateEntry(to, "write")
              if (await FileEntry.inspect(to)) throw new WriteConflictError()
              const parent = path.dirname(to)
              let createdParent = false
              try {
                if (!(await FileEntry.inspect(parent))) {
                  await FileEntry.mkdir({
                    path: parent,
                    createParents: true,
                    mode: 0o700,
                    signal,
                    validate: validateEntry,
                  })
                  createdParent = true
                }
                await FileEntry.copy({
                  from,
                  to,
                  expectedVersion: source.version,
                  signal,
                  async validate(target, operation) {
                    if (operation === "write") return validateEntry(target, operation)
                    if (!isPathContained(from, target, { followFinalSymlink: false }))
                      throw new AccessDeniedError("Import source escaped its owner")
                    await input.validateSource(target)
                  },
                })
                return await changedEntry(to)
              } catch (cause) {
                if (createdParent && !(cause instanceof PartialMutationError))
                  throw new PartialMutationError(
                    "Import did not publish its target; parent directories were created",
                    [parent],
                    { cause },
                  )
                throw cause
              }
            },
            signal,
          ),
        ),
      signal,
    )
  }

  export async function remove(input: WorkspaceFile.DeleteInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const absolute = resolve(input.path, { followFinalSymlink: false })
      await validateEntry(absolute, "write")
      try {
        if (FileView.native()) await FileEntry.remove({ ...input, path: absolute, signal, validate: validateEntry })
        else await FileView.mutate({ ...input, kind: "remove", path: relative(absolute) }, signal, true)
        await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
          file: displayRelative(absolute),
          event: "deleted",
          parent: displayRelative(FileView.dirname(absolute)),
        }).catch((cause) => {
          throw new PartialMutationError("Entry removed, but publishing the update failed", [absolute], { cause })
        })
        return { path: displayRelative(absolute), removed: true as const }
      } finally {
        WorkspaceFileStatus.invalidate()
        WorkspaceFileIndexer.invalidate()
      }
    })
  }

  export async function maybeNode(
    input: string,
    options?: { resolveGitStatus?: boolean; gitStatus?: WorkspaceFile.GitStatus },
  ) {
    return node(input, options).catch(() => undefined)
  }

  function visible(node: WorkspaceFile.Node, options: { showHidden?: boolean; showIgnored?: boolean }) {
    if (!options.showHidden && node.hidden) return false
    if (!options.showIgnored && node.ignored) return false
    return true
  }

  async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const result = new Array<R>(items.length)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const index = next++
          result[index] = await fn(items[index]!)
        }
      }),
    )
    return result
  }

  export async function children(input: {
    path?: string
    limit?: number
    cursor?: string
    showHidden?: boolean
    showIgnored?: boolean
  }): Promise<WorkspaceFile.ChildrenResponse> {
    const absolute = resolve(input.path ?? "")
    await assertRealpathInside(absolute)
    const parent = await node(absolute, { resolveGitStatus: false })
    if (parent.type !== "directory") {
      return {
        path: parent.path,
        parent,
        children: [],
        truncated: false,
      }
    }

    const entries = (await FileView.list(absolute))
      .map((entry) => {
        const relativePath = entry.path
        return {
          entry,
          relativePath,
          hidden: hiddenPath(relativePath),
          ignored: isIgnored(relativePath),
        }
      })
      .filter((item) => input.showHidden || !item.hidden)
      .filter((item) => input.showIgnored || !item.ignored)
      .sort((a, b) => {
        const aDir = a.entry.kind === "directory"
        const bDir = b.entry.kind === "directory"
        if (aDir !== bDir) return aDir ? -1 : 1
        return naturalCollator.compare(path.posix.basename(a.entry.path), path.posix.basename(b.entry.path))
      })

    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0)
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_CHILDREN_LIMIT, 1000))
    const pageEntries = entries.slice(offset, offset + limit)
    const page = (
      await mapConcurrent(pageEntries, NODE_CONCURRENCY, (item) =>
        node(item.entry.path, {
          resolveGitStatus: false,
        }).catch(() => undefined),
      )
    ).filter((item): item is WorkspaceFile.Node => !!item && visible(item, input))
    const next = offset + pageEntries.length
    return {
      path: parent.path,
      parent,
      children: page,
      nextCursor: next < entries.length ? String(next) : undefined,
      truncated: next < entries.length,
    }
  }

  export async function read(input: {
    path: string
    offset?: number
    limit?: number
    preview?: boolean
    mode?: "range" | "document"
  }): Promise<WorkspaceFile.ReadResult> {
    const lease = FileView.native() ? await WorkspaceAccess.pin() : undefined
    try {
      return await WorkspaceFileRead.read(input, { resolve, node, validate: assertRealpathInside })
    } finally {
      await lease?.release()
    }
  }
  const PREVIEW_MAX_BYTES = 50 * 1024 * 1024
  const PREVIEW_MIME_PDF = "application/pdf"

  export class UnsupportedPreviewError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "WorkspaceFileUnsupportedPreviewError"
    }
  }

  export async function content(input: {
    path: string
    signal?: AbortSignal
  }): Promise<{ absolute: string; node: WorkspaceFile.Node; stream: ReadableStream }> {
    const absolute = resolve(input.path)
    await assertRealpathInside(absolute)
    const info = await node(absolute, { resolveGitStatus: false })
    if (info.type !== "file") {
      throw new AccessDeniedError(`Access denied: path is not a file (${info.path})`)
    }
    const file = Bun.file(absolute)
    const mime = file.type
    if (!(path.extname(absolute).toLowerCase() === ".pdf" || mime === PREVIEW_MIME_PDF)) {
      throw new UnsupportedPreviewError(`Unsupported preview: only PDF files support content preview (${info.path})`)
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      throw new TooLargeError(`File too large to preview (${info.size} bytes, limit ${PREVIEW_MAX_BYTES})`)
    }
    const opened = await WorkspaceFileStream.open({
      path: absolute,
      limit: PREVIEW_MAX_BYTES,
      signal: input.signal,
      validate: assertRealpathInside,
    })
    return {
      absolute,
      node: { ...info, size: opened.stat.size, mtime: opened.stat.mtimeMs, ctime: opened.stat.ctimeMs },
      stream: opened.stream,
    }
  }

  export async function serveFile(input: {
    path: string
    signal?: AbortSignal
  }): Promise<{ absolute: string; node: WorkspaceFile.Node; stream: ReadableStream; mime: string }> {
    const absolute = resolve(input.path)
    await assertRealpathInside(absolute)
    const info = await node(absolute, { resolveGitStatus: false })
    if (info.type !== "file") {
      throw new AccessDeniedError(`Access denied: path is not a file (${info.path})`)
    }
    if (info.size > PREVIEW_MAX_BYTES) {
      throw new TooLargeError(`File too large to serve (${info.size} bytes, limit ${PREVIEW_MAX_BYTES})`)
    }
    const file = Bun.file(absolute)
    const opened = await WorkspaceFileStream.open({
      path: absolute,
      limit: PREVIEW_MAX_BYTES,
      signal: input.signal,
      validate: assertRealpathInside,
    })
    return {
      absolute,
      node: { ...info, size: opened.stat.size, mtime: opened.stat.mtimeMs, ctime: opened.stat.ctimeMs },
      stream: opened.stream,
      mime: file.type,
    }
  }
  const WRITE_MAX_BYTES = 8 * 1024 * 1024

  function assertWritableTarget(absolute: string) {
    const relativePath = displayRelative(absolute)
    const protectedMatch = SensitivePathPolicy.classify(relativePath, {
      mode: "write",
      workspaceRoot: root(),
    })
    if (protectedMatch.matched) {
      const kind = protectedMatch.category === "vcs" ? "Git metadata" : "secret or credential path"
      throw new AccessDeniedError(`Access denied: ${kind} is not editable (${relativePath})`)
    }
  }

  async function assertRealpathWritable(absolute: string) {
    assertWritableTarget(await FileView.canonical(absolute))
  }

  export async function write(
    input: WorkspaceFile.WriteFileInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceFile.WriteFileResult> {
    const absolute = resolve(input.path)
    await assertRealpathInside(absolute)
    assertWritableTarget(absolute)
    await assertRealpathWritable(absolute)
    const content = input.encoding === "base64" ? Buffer.from(input.content, "base64") : input.content
    if (typeof content !== "string" && content.toString("base64") !== input.content)
      throw new InvalidContentError("Content must be canonical base64")
    const byteLength = Buffer.byteLength(content)
    if (byteLength > WRITE_MAX_BYTES)
      throw new TooLargeError(`File too large to write (${byteLength} bytes, limit ${WRITE_MAX_BYTES})`)
    const result = await FileMutation.write({
      path: absolute,
      protectSensitive: true,
      content,
      expectedVersion: input.conflictPolicy === "overwrite" ? undefined : input.expectedVersion,
      createParents: input.createParents,
      signal,
      async validate(target) {
        await assertRealpathInside(target)
        assertWritableTarget(target)
      },
    })
    WorkspaceFileStatus.invalidate()
    WorkspaceFileIndexer.invalidate()
    await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
      file: displayRelative(absolute),
      event: result.existed ? "changed" : "added",
      parent: displayRelative(FileView.dirname(absolute)),
    })
    return { path: displayRelative(absolute), ...result }
  }
}
