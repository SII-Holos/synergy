import fs from "node:fs/promises"
import path from "node:path"
import { StorageIntegrityError } from "./errors"

const recordRoots = new Set([
  "projects",
  "sessions",
  "operations",
  "session_index",
  "endpoint_session",
  "sessions_page_index",
  "session_child_index",
  "session_nav_v2",
  "session_search_v1",
  "session_search_dirty_v1",
  "session_message_order_v1",
  "permissions",
  "permission-rules",
  "shares",
  "meta",
  "agenda",
  "notes",
  "blueprint_loops",
  "superplan",
  "lattice",
  "holos",
  "synergy_link",
  "stats",
  "snapshot-v2",
  "plugin-approvals",
  "plugin-audit",
  "plugin-runtime-state",
  "plugin-incompatible",
  "registry",
])

export function legacyRecordKey(relative: string): string[] | undefined {
  if (relative === "@home/plugin.lock") return ["plugin-lock"]
  if (!relative.endsWith(".json")) return
  const key = relative.slice(0, -5).split("/")
  if (key.some((segment) => !segment || segment === "." || segment === ".."))
    throw new StorageIntegrityError("Invalid legacy record path")
  if (key[0] === "channel") {
    if (key[1] === "workspaces") return
    return key
  }
  if (key[0] === "browser" && /^sessions(?:-v\d+)?$/.test(key[1] ?? "")) return key
  if (key[0] === "push" && key[1] === "subscriptions") return key
  if (key[0] === "library" && key[1] === "stats") return key
  if (key[0] === "snapshot-v2" && (key.includes(".locks") || key.includes("leases"))) return
  return recordRoots.has(key[0]) ? key : undefined
}

function recordDirectory(segments: string[]) {
  const [root, child] = segments
  if (root === "channel") return child !== "workspaces"
  if (root === "browser") return !child || /^sessions(?:-v\d+)?$/.test(child)
  if (root === "push") return !child || child === "subscriptions"
  if (root === "library") return !child || child === "stats"
  if (root === "snapshot-v2" && (segments.includes(".locks") || segments.includes("leases"))) return false
  return recordRoots.has(root)
}

export async function* legacyRecords(dataRoot: string, visit?: () => void): AsyncGenerator<string> {
  async function* walk(segments: string[]): AsyncGenerator<string> {
    const directory = await fs.opendir(path.join(dataRoot, ...segments))
    for await (const entry of directory) {
      if (entry.name === ".locks" || entry.name.startsWith(".tmp-") || entry.name.endsWith(".tmp")) continue
      visit?.()
      const child = [...segments, entry.name]
      const relative = child.join("/")
      if (entry.isDirectory()) {
        if (recordDirectory(child)) yield* walk(child)
      } else if (entry.isSymbolicLink()) {
        if (recordRoots.has(child[0]) || legacyRecordKey(relative))
          throw new StorageIntegrityError("Authoritative legacy records cannot be symbolic links")
      } else if (entry.isFile()) {
        if (legacyRecordKey(relative)) yield relative
      } else if (recordDirectory(child) || legacyRecordKey(relative))
        throw new StorageIntegrityError("Legacy storage contains an unsupported file type")
    }
  }
  yield* walk([])
  try {
    const lock = await fs.lstat(path.join(dataRoot, "..", "plugin.lock"))
    if (!lock.isFile() || lock.isSymbolicLink())
      throw new StorageIntegrityError("Plugin installation metadata is not a regular file")
    yield "@home/plugin.lock"
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
}

export async function* legacyFiles(
  root: string,
  segments: string[] = [],
): AsyncGenerator<{ relative: string; size: number; linkTarget?: string }> {
  const directory = await fs.readdir(path.join(root, ...segments), { withFileTypes: true })
  directory.sort((a, b) => {
    const left = a.name + (a.isDirectory() ? "/" : "")
    const right = b.name + (b.isDirectory() ? "/" : "")
    return left < right ? -1 : left > right ? 1 : 0
  })
  for (const entry of directory) {
    if (entry.name === ".locks" || entry.name.startsWith(".tmp-") || entry.name.endsWith(".tmp")) continue
    if (segments.length === 0 && ["storage", "agent-artifacts"].includes(entry.name)) continue
    const child = [...segments, entry.name]
    if (entry.isSymbolicLink()) {
      const relative = child.join("/")
      if (recordRoots.has(child[0]) || legacyRecordKey(relative))
        throw new StorageIntegrityError("Authoritative legacy records cannot be symbolic links")
      const linkTarget = await fs.readlink(path.join(root, ...child))
      yield { relative, size: Buffer.byteLength(linkTarget), linkTarget }
      continue
    }
    if (entry.isDirectory()) yield* legacyFiles(root, child)
    else if (entry.isFile()) {
      const stat = await fs.stat(path.join(root, ...child))
      yield { relative: child.join("/"), size: stat.size }
    } else throw new StorageIntegrityError("Legacy storage contains an unsupported file type")
  }
}

export async function* legacySources(
  dataRoot: string,
): AsyncGenerator<{ relative: string; size: number; linkTarget?: string }> {
  yield* legacyFiles(dataRoot)
  const config = path.join(dataRoot, "..", "config")
  try {
    for await (const entry of legacyFiles(config)) yield { ...entry, relative: `@home/config/${entry.relative}` }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
  const lock = path.join(dataRoot, "..", "plugin.lock")
  try {
    const stat = await fs.lstat(lock)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new StorageIntegrityError("Plugin installation metadata is not a regular file")
    yield { relative: "@home/plugin.lock", size: stat.size }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
}

export function sourcePath(dataRoot: string, relative: string) {
  if (relative === "@home/plugin.lock") return path.join(dataRoot, "..", "plugin.lock")
  const segments = relative.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\")))
    throw new StorageIntegrityError("Unsafe migration source identity")
  return segments[0] === "@home" ? path.join(dataRoot, "..", ...segments.slice(1)) : path.join(dataRoot, ...segments)
}

export function legacyBinaryKey(relative: string): string[] | undefined {
  if (!relative.endsWith(".bin")) return
  const key = relative.slice(0, -4).split("/")
  if (key.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part)))
    throw new StorageIntegrityError("Invalid legacy binary path")
  const index = key.indexOf("rollout")
  if (
    index >= 0 &&
    key[index + 1] === "blobs" &&
    index + 3 === key.length &&
    ["sessions", "operations", "meta"].includes(key[0])
  )
    return key
}

export async function syncRetiredDirectories(dataRoot: string, directories: Iterable<string>) {
  const root = path.resolve(dataRoot)
  for (const initial of directories) {
    let directory = initial
    for (;;) {
      if (process.platform !== "win32") {
        try {
          const handle = await fs.open(directory, "r")
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
        }
      }
      const relative = path.relative(root, directory)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) break
      try {
        await fs.rmdir(directory)
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["ENOTEMPTY", "EEXIST"].includes(String(error.code))
        )
          break
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      }
      directory = path.dirname(directory)
    }
  }
}
