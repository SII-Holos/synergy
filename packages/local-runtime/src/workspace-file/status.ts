import { $ } from "bun"
import path from "path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceFile } from "./types"
import { WorkspaceFileStatusCache } from "./status-cache"

type StatusEntry = {
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
  return input.replace(/^\/+/, "")
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
  const cwd = root()
  const repository = await $`git rev-parse --is-inside-work-tree`.cwd(cwd).quiet().nothrow()
  if (repository.exitCode !== 0 || repository.stdout.toString().trim() !== "true") return { files: [] }
  const counts = new Map<string, { added: number; removed: number }>()
  const [numstat, nameStatus, untracked] = await Promise.all([
    $`git diff --numstat --no-renames --relative -z HEAD -- .`.cwd(cwd).quiet().nothrow().text(),
    $`git diff --name-status -M --relative -z HEAD -- .`.cwd(cwd).quiet().nothrow().text(),
    $`git ls-files --others --exclude-standard -z -- .`.cwd(cwd).quiet().nothrow().text(),
  ])
  for (const line of numstat.split("\0").filter(Boolean)) {
    const first = line.indexOf("\t")
    const second = line.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    const added = line.slice(0, first)
    const removed = line.slice(first + 1, second)
    const filepath = line.slice(second + 1)
    if (!filepath) continue
    counts.set(cleanRelative(filepath), {
      added: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      removed: removed === "-" ? 0 : Number.parseInt(removed, 10) || 0,
    })
  }

  const files = new Map<string, WorkspaceFile.StatusSummary["files"][number]>()
  const names = nameStatus.split("\0")
  for (let i = 0; i < names.length - 1; ) {
    const status = parseStatus(names[i++]!)
    const oldPath = names[i++] ?? ""
    const filepath = cleanRelative(status === "renamed" ? (names[i++] ?? "") : oldPath)
    if (!filepath) continue
    files.set(filepath, {
      path: filepath,
      status,
      ...counts.get(filepath),
    })
  }

  const untrackedFiles = untracked.split("\0").filter(Boolean)
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
  const state = WorkspaceState.create(() =>
    WorkspaceFileStatusCache.create<StatusEntry>({
      ttlMs: STATUS_TTL_MS,
      build: async () => {
        const summary = await build()
        return {
          summary,
          byPath: new Map(summary.files.map((file) => [file.path, file.status])),
        }
      },
    }),
  )

  export function invalidate() {
    state().invalidate()
  }

  export async function summary(options?: { force?: boolean }): Promise<WorkspaceFile.StatusSummary> {
    return (await state().get(options)).summary
  }

  export async function statusForPath(relativePath: string): Promise<WorkspaceFile.GitStatus | undefined> {
    if (!relativePath) return undefined
    return (await state().get()).byPath.get(relativePath)
  }

  export async function statusMap(): Promise<ReadonlyMap<string, WorkspaceFile.GitStatus>> {
    return (await state().get()).byPath
  }
}
