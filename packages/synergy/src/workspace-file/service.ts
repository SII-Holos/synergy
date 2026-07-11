import { fileURLToPath } from "url"
import fs from "fs/promises"
import path from "path"
import { ScopeContext } from "../scope/context"
import { FileIgnore } from "../file/ignore"
import { WorkspaceFile } from "./types"
import { WorkspaceFileRead, likelyBinaryByExtension } from "./read"
import { WorkspaceFileStatus } from "./status"
import { isPathContained } from "../util/path-contain"

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

async function realpathIfExists(input: string) {
  return fs.realpath(input).catch(() => undefined)
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
  export class AccessDeniedError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "WorkspaceFileAccessDeniedError"
    }
  }

  export function resolve(input = "") {
    if (isControlPath(input)) throw new AccessDeniedError("Path contains control characters")
    const cleaned = stripFileProtocol(input.trim())
    const workspace = root()
    const absolute = path.resolve(workspace, cleaned || ".")
    if (!isPathContained(workspace, absolute)) {
      throw new AccessDeniedError("Access denied: path escapes workspace")
    }
    return absolute
  }

  export function relative(input: string) {
    const absolute = path.isAbsolute(input) ? path.resolve(input) : resolve(input)
    if (!isPathContained(root(), absolute)) throw new AccessDeniedError("Access denied: path escapes workspace")
    return displayRelative(absolute)
  }

  export async function assertRealpathInside(absolute: string) {
    const real = await realpathIfExists(absolute)
    if (real && !isPathContained(root(), real)) {
      throw new AccessDeniedError("Access denied: real path escapes workspace")
    }
  }

  export function isIgnored(relativePath: string) {
    if (!relativePath) return false
    return FileIgnore.match(relativePath)
  }

  export async function node(
    input: string,
    options?: { resolveGitStatus?: boolean; gitStatus?: WorkspaceFile.GitStatus },
  ): Promise<WorkspaceFile.Node> {
    const absolute = path.isAbsolute(input) ? input : resolve(input)
    if (!isPathContained(root(), absolute)) throw new AccessDeniedError("Access denied: path escapes workspace")
    await assertRealpathInside(absolute)

    const relativePath = displayRelative(absolute)
    const stat = await fs.lstat(absolute)
    const symlink = stat.isSymbolicLink()
    const targetStat = symlink ? await fs.stat(absolute).catch(() => undefined) : stat
    const type: WorkspaceFile.NodeType = targetStat?.isDirectory()
      ? "directory"
      : targetStat?.isFile()
        ? "file"
        : symlink
          ? "symlink"
          : "unknown"
    const file = Bun.file(absolute)
    const mime = file.type
    const binary = type === "file" && (mime?.startsWith("text/") ? false : likelyBinaryByExtension(absolute))
    const gitStatus =
      options?.resolveGitStatus === false ? options.gitStatus : await WorkspaceFileStatus.statusForPath(relativePath)

    return {
      path: relativePath,
      name: relativePath ? path.basename(relativePath) : path.basename(root()),
      type,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      ignored: isIgnored(relativePath),
      hidden: hiddenPath(relativePath),
      readonly: (stat.mode & 0o200) === 0,
      symlink,
      binary,
      gitStatus,
    }
  }

  export async function maybeNode(input: string) {
    return node(input).catch(() => undefined)
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
    return WorkspaceFileRead.read(input, { resolve, node })
  }
}
