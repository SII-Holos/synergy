import { $ } from "bun"
import path from "path"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { WorkspaceFile } from "./types"

type StatusEntry = {
  fetchedAt: number
  summary: WorkspaceFile.StatusSummary
  byPath: Map<string, WorkspaceFile.GitStatus>
}

const STATUS_TTL_MS = 5_000
const MAX_UNTRACKED_LINE_COUNT_FILES = 200
const MAX_UNTRACKED_LINE_COUNT_BYTES = 256 * 1024

function root() {
  return ScopeContext.current.directory
}

function cleanRelative(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "")
}

function parseStatus(input: string): WorkspaceFile.GitStatus {
  const code = input[0]
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "R") return "renamed"
  return "modified"
}

async function lineCount(filepath: string) {
  const stat = await Bun.file(filepath)
    .stat()
    .catch(() => undefined)
  if (!stat || stat.size > MAX_UNTRACKED_LINE_COUNT_BYTES) return undefined
  const content = await Bun.file(filepath)
    .text()
    .catch(() => undefined)
  if (content === undefined) return undefined
  if (!content) return 0
  return content.split(/\r?\n/).length
}

async function build(): Promise<WorkspaceFile.StatusSummary> {
  const scope = ScopeContext.current.scope
  if (scope.type !== "project" || scope.vcs !== "git") return { files: [] }

  const cwd = root()
  const counts = new Map<string, { added: number; removed: number }>()
  const numstat = await $`git diff --numstat HEAD`.cwd(cwd).quiet().nothrow().text()
  for (const line of numstat.trim().split(/\r?\n/).filter(Boolean)) {
    const [added, removed, filepath] = line.split("\t")
    if (!filepath) continue
    counts.set(cleanRelative(filepath), {
      added: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      removed: removed === "-" ? 0 : Number.parseInt(removed, 10) || 0,
    })
  }

  const files = new Map<string, WorkspaceFile.StatusSummary["files"][number]>()
  const nameStatus = await $`git diff --name-status -M HEAD`.cwd(cwd).quiet().nothrow().text()
  for (const line of nameStatus.trim().split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t")
    const status = parseStatus(parts[0] ?? "M")
    const filepath = cleanRelative(status === "renamed" ? (parts[2] ?? parts[1] ?? "") : (parts[1] ?? ""))
    if (!filepath) continue
    files.set(filepath, {
      path: filepath,
      status,
      ...counts.get(filepath),
    })
  }

  const untracked = await $`git ls-files --others --exclude-standard`.cwd(cwd).quiet().nothrow().text()
  const untrackedFiles = untracked.trim().split(/\r?\n/).filter(Boolean)
  const shouldCountUntrackedLines = untrackedFiles.length <= MAX_UNTRACKED_LINE_COUNT_FILES
  for (const filepath of untrackedFiles) {
    const relative = cleanRelative(filepath)
    const absolute = path.join(cwd, relative)
    const added = shouldCountUntrackedLines ? await lineCount(absolute) : undefined
    files.set(relative, {
      path: relative,
      status: "untracked",
      ...(added === undefined ? {} : { added, removed: 0 }),
    })
  }

  return {
    files: Array.from(files.values()).toSorted((a, b) => a.path.localeCompare(b.path)),
  }
}

export namespace WorkspaceFileStatus {
  const state = ScopedState.create<StatusEntry>(() => ({
    fetchedAt: 0,
    summary: { files: [] },
    byPath: new Map(),
  }))

  export function invalidate() {
    state().fetchedAt = 0
  }

  export async function summary(options?: { force?: boolean }): Promise<WorkspaceFile.StatusSummary> {
    const entry = state()
    const stale = Date.now() - entry.fetchedAt > STATUS_TTL_MS
    if (options?.force || entry.fetchedAt === 0 || stale) {
      entry.summary = await build()
      entry.byPath = new Map(entry.summary.files.map((file) => [file.path, file.status]))
      entry.fetchedAt = Date.now()
    }
    return entry.summary
  }

  export async function statusForPath(relativePath: string): Promise<WorkspaceFile.GitStatus | undefined> {
    if (!relativePath) return undefined
    await summary()
    return state().byPath.get(relativePath)
  }

  export async function statusMap(): Promise<ReadonlyMap<string, WorkspaceFile.GitStatus>> {
    await summary()
    return state().byPath
  }
}
