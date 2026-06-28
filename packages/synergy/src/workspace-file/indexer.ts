import path from "path"
import { ScopedState } from "../scope/scoped-state"
import { ScopeContext } from "../scope/context"
import { Ripgrep } from "../file/ripgrep"
import { WorkspaceFileService } from "./service"

type Entry = {
  files: string[]
  dirs: string[]
  fetching: boolean
  fetchedAt: number
}

const INDEX_TTL_MS = 30_000

function root() {
  return ScopeContext.current.directory
}

function addParents(dirs: Set<string>, file: string) {
  let current = file
  while (true) {
    const dir = path.dirname(current)
    if (dir === "." || dir === current) break
    current = dir
    dirs.add(dir.replaceAll("\\", "/") + "/")
  }
}

function cleanRelative(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "")
}

function scanSignal(signal: AbortSignal | undefined) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
}

async function scan(input?: { signal?: AbortSignal }): Promise<{ files: string[]; dirs: string[] }> {
  const files: string[] = []
  const dirs = new Set<string>()
  const signal = scanSignal(input?.signal)
  for await (const file of Ripgrep.files({ cwd: root(), signal })) {
    if (signal.aborted) break
    const relative = cleanRelative(file)
    if (!relative) continue
    files.push(relative)
    addParents(dirs, relative)
  }
  return {
    files: files.toSorted(),
    dirs: Array.from(dirs).toSorted(),
  }
}

export namespace WorkspaceFileIndexer {
  const state = ScopedState.create<Entry>(() => ({
    files: [],
    dirs: [],
    fetching: false,
    fetchedAt: 0,
  }))

  async function refresh(entry: Entry, options?: { signal?: AbortSignal }) {
    if (entry.fetching) return
    entry.fetching = true
    try {
      const next = await scan({ signal: options?.signal })
      entry.files = next.files
      entry.dirs = next.dirs
      entry.fetchedAt = Date.now()
    } finally {
      entry.fetching = false
    }
  }

  export async function snapshot(options?: { force?: boolean; signal?: AbortSignal }) {
    const entry = state()
    const stale = Date.now() - entry.fetchedAt > INDEX_TTL_MS
    if (options?.force || (!entry.fetching && (entry.fetchedAt === 0 || stale))) {
      await refresh(entry, { signal: options?.signal })
    }
    return {
      files: entry.files,
      dirs: entry.dirs,
      fetching: entry.fetching,
      fetchedAt: entry.fetchedAt,
    }
  }

  export function invalidate() {
    const entry = state()
    entry.fetchedAt = 0
  }

  export async function applyChange(input: { path: string; event: "add" | "change" | "unlink" }) {
    const entry = state()
    const relative = cleanRelative(input.path)
    if (!relative) return

    if (input.event === "unlink") {
      entry.files = entry.files.filter((item) => item !== relative)
      entry.dirs = entry.dirs.filter((item) => item !== relative + "/" && !item.startsWith(relative + "/"))
      return
    }

    const node = await WorkspaceFileService.maybeNode(relative)
    if (!node) {
      invalidate()
      return
    }
    if (node.type === "directory") {
      const dir = node.path.endsWith("/") ? node.path : node.path + "/"
      if (!entry.dirs.includes(dir)) entry.dirs = [...entry.dirs, dir].toSorted()
      return
    }
    if (node.type === "file" && !entry.files.includes(node.path)) {
      entry.files = [...entry.files, node.path].toSorted()
      const dirs = new Set(entry.dirs)
      addParents(dirs, node.path)
      entry.dirs = Array.from(dirs).toSorted()
    }
  }

  export async function applyRename(input: { from: string; to: string }) {
    await applyChange({ path: input.from, event: "unlink" })
    await applyChange({ path: input.to, event: "add" })
  }
}
