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

  export async function node(input: string): Promise<WorkspaceFile.Node> {
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
    const gitStatus = await WorkspaceFileStatus.statusForPath(relativePath)

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

    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [])
    const nodes = (
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.name === "." || entry.name === "..") return undefined
          return maybeNode(path.join(absolute, entry.name))
        }),
      )
    )
      .filter((item): item is WorkspaceFile.Node => !!item)
      .filter((item) => visible(item, input))
      .sort((a, b) => {
        const aDir = a.type === "directory"
        const bDir = b.type === "directory"
        if (aDir !== bDir) return aDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0)
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_CHILDREN_LIMIT, 1000))
    const page = nodes.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      path: parent.path,
      parent,
      children: page,
      nextCursor: next < nodes.length ? String(next) : undefined,
      truncated: next < nodes.length,
    }
  }

  export async function read(input: {
    path: string
    offset?: number
    limit?: number
    preview?: boolean
  }): Promise<WorkspaceFile.ReadResult> {
    return WorkspaceFileRead.read(input, { resolve, node })
  }
}
