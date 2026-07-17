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
const APPLY_CONCURRENCY = 16

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

  export async function applyChanges(inputs: Array<{ path: string; event: "add" | "change" | "unlink" }>) {
    const entry = state()
    const changes = inputs
      .map((input) => ({ ...input, path: cleanRelative(input.path) }))
      .filter((input) => input.path.length > 0)
    const nodes = new Map<string, Awaited<ReturnType<typeof WorkspaceFileService.maybeNode>>>()
    const workerCount = Math.min(APPLY_CONCURRENCY, changes.length)

    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIndex) => {
        for (let index = workerIndex; index < changes.length; index += workerCount) {
          const change = changes[index]!
          if (change.event === "unlink") continue
          const node = await WorkspaceFileService.maybeNode(change.path, { resolveGitStatus: false })
          nodes.set(change.path, node)
        }
      }),
    )

    const files = new Set(entry.files)
    const dirs = new Set(entry.dirs)
    let invalid = false
    for (const change of changes) {
      const relative = change.path
      if (change.event === "unlink") {
        files.delete(relative)
        for (const dir of [...dirs]) {
          if (dir === relative + "/" || dir.startsWith(relative + "/")) dirs.delete(dir)
        }
        continue
      }

      const node = nodes.get(relative)
      if (!node) {
        invalid = true
        continue
      }
      if (node.type === "directory") {
        dirs.add(node.path.endsWith("/") ? node.path : node.path + "/")
        continue
      }
      if (node.type === "file") {
        files.add(node.path)
        addParents(dirs, node.path)
      }
    }

    entry.files = [...files].toSorted()
    entry.dirs = [...dirs].toSorted()
    if (invalid) invalidate()
    return new Map([...nodes].filter((item): item is [string, NonNullable<(typeof item)[1]>] => !!item[1]))
  }

  export async function applyChange(input: { path: string; event: "add" | "change" | "unlink" }) {
    await applyChanges([input])
  }

  export async function applyRename(input: { from: string; to: string }) {
    await applyChanges([
      { path: input.from, event: "unlink" },
      { path: input.to, event: "add" },
    ])
  }
}
