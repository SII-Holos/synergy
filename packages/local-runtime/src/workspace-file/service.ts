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
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileIgnore } from "../file/ignore"
import { WorkspaceFile } from "./types"
import { WorkspaceFileRead, likelyBinaryByExtension } from "./read"
import { WorkspaceFileStatus } from "./status"
import { isPathContained } from "@ericsanchezok/synergy-harness/util/path-contain"
import { SensitivePathPolicy } from "@ericsanchezok/synergy-harness/enforcement/sensitive-path"

const DEFAULT_CHILDREN_LIMIT = 200
const NODE_CONCURRENCY = 16
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function root() {
  return path.resolve(ScopeContext.current.directory)
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
    const workspace = root()
    const absolute = path.resolve(workspace, cleaned || ".")
    if (!isPathContained(workspace, absolute, options)) {
      throw new AccessDeniedError("Access denied: path escapes workspace")
    }
    return absolute
  }

  export function relative(input: string) {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : resolve(input)
    if (!isPathContained(root(), absolute, { followFinalSymlink: false }))
      throw new AccessDeniedError("Access denied: path escapes workspace")
    return displayRelative(absolute)
  }

  export async function assertRealpathInside(absolute: string) {
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
    const absolute = path.isAbsolute(input) ? input : resolve(input, { followFinalSymlink: false })
    if (!isPathContained(root(), absolute, { followFinalSymlink: false }))
      throw new AccessDeniedError("Access denied: path escapes workspace")
    await assertEntryInside(absolute)

    const relativePath = displayRelative(absolute)
    const entry = await FileEntry.inspect(absolute)
    if (!entry) throw Object.assign(new NotFoundError("Filesystem entry not found"), { code: "ENOENT" })
    const stat = entry.stat
    const symlink = stat.isSymbolicLink()
    const targetStat = symlink
      ? await assertRealpathInside(absolute)
          .then(() => fs.stat(absolute, { bigint: true }))
          .catch(() => undefined)
      : stat
    const type: WorkspaceFile.NodeType = targetStat?.isDirectory()
      ? "directory"
      : targetStat?.isFile()
        ? "file"
        : symlink
          ? "symlink"
          : "unknown"
    const metadata = targetStat ?? stat
    const file = Bun.file(absolute)
    const mime = file.type
    const binary = type === "file" && (mime?.startsWith("text/") ? false : likelyBinaryByExtension(absolute))
    const gitStatus =
      options?.resolveGitStatus === false ? options.gitStatus : await WorkspaceFileStatus.statusForPath(relativePath)

    return {
      path: relativePath,
      entryVersion: entry.version,
      name: relativePath ? path.basename(relativePath) : path.basename(root()),
      type,
      size: Number(metadata.size),
      mtime: Number(metadata.mtimeNs) / 1e6,
      ctime: Number(metadata.ctimeNs) / 1e6,
      ignored: isIgnored(relativePath),
      hidden: hiddenPath(relativePath),
      readonly: (metadata.mode & 0o200n) === 0n,
      symlink,
      binary,
      gitStatus,
    }
  }

  async function assertEntryInside(absolute: string) {
    const [entry, realRoot] = await Promise.all([FileEntry.canonical(absolute), fs.realpath(root())])
    if (!isPathContained(realRoot, entry, { followFinalSymlink: false }))
      throw new AccessDeniedError("Access denied: entry parent escapes workspace")
  }

  async function validateEntry(absolute: string, operation: "read" | "write") {
    await assertEntryInside(absolute)
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
        parent: displayRelative(path.dirname(absolute)),
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
      await FileEntry.mkdir({ ...input, path: absolute, signal, validate: validateEntry })
      return changedEntry(absolute)
    })
  }
  export async function move(input: WorkspaceFile.MoveInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const from = resolve(input.from, { followFinalSymlink: false }),
        to = resolve(input.to, { followFinalSymlink: false })
      await validateEntry(from, "write")
      try {
        await FileEntry.move({ ...input, from, to, signal, validate: validateEntry })
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
      await FileEntry.copy({ ...input, from, to, signal, validate: validateEntry })
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
    return WorkspaceAccess.withinTask(
      () =>
        entryOperation(async () => {
          await WorkspaceAccess.reserveWrite([root(), path.dirname(from)], signal)
          await validateEntry(to, "write")
          if (await FileEntry.inspect(to)) throw new WriteConflictError()
          const parent = path.dirname(to)
          let createdParent = false
          try {
            if (!(await FileEntry.inspect(parent))) {
              await FileEntry.mkdir({ path: parent, createParents: true, mode: 0o700, signal, validate: validateEntry })
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
        }),
      signal,
    )
  }

  export async function remove(input: WorkspaceFile.DeleteInput, signal?: AbortSignal) {
    return entryOperation(async () => {
      const absolute = resolve(input.path, { followFinalSymlink: false })
      await validateEntry(absolute, "write")
      try {
        await FileEntry.remove({ ...input, path: absolute, signal, validate: validateEntry })
        await WorkspaceEvents.publish(FileWatcherEvent.Updated, {
          file: displayRelative(absolute),
          event: "deleted",
          parent: displayRelative(path.dirname(absolute)),
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
    const parent = await node(absolute)
    if (parent.type !== "directory") {
      return {
        path: parent.path,
        parent,
        children: [],
        truncated: false,
      }
    }

    const entries = (await fs.readdir(absolute, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.name !== "." && entry.name !== "..")
      .map((entry) => {
        const relativePath = displayRelative(path.join(absolute, entry.name))
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
        const aDir = a.entry.isDirectory()
        const bDir = b.entry.isDirectory()
        if (aDir !== bDir) return aDir ? -1 : 1
        return naturalCollator.compare(a.entry.name, b.entry.name)
      })

    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0)
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_CHILDREN_LIMIT, 1000))
    const pageEntries = entries.slice(offset, offset + limit)
    const statusMap = await WorkspaceFileStatus.statusMap()
    const page = (
      await mapConcurrent(pageEntries, NODE_CONCURRENCY, (item) =>
        node(path.join(absolute, item.entry.name), {
          resolveGitStatus: false,
          gitStatus: statusMap.get(item.relativePath),
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
    const lease = await WorkspaceAccess.pin()
    try {
      return await WorkspaceFileRead.read(input, { resolve, node, validate: assertRealpathInside })
    } finally {
      await lease.release()
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
    assertWritableTarget(await FileMutation.canonical(absolute))
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
    return { path: displayRelative(absolute), ...result }
  }
}
