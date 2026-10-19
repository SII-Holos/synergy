import path from "path"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorktreeProcess } from "../workspace/process"
import { FileView } from "../file/view"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceFile } from "./types"
import { WorkspaceFileStatusCache } from "./status-cache"
import { Bus } from "@ericsanchezok/synergy-harness/bus"

type StatusEntry = {
  summary: WorkspaceFile.StatusSummary
  byPath: Map<string, WorkspaceFile.GitStatus>
}

const STATUS_TTL_MS = 5_000
const MAX_UNTRACKED_LINE_COUNT_FILES = 200
const MAX_UNTRACKED_LINE_COUNT_BYTES = 256 * 1024

function root() {
  return FileView.directory()
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
  const stat = await FileView.file(filepath)
    .stat()
    .catch(() => undefined)
  if (!stat || stat.size > MAX_UNTRACKED_LINE_COUNT_BYTES) return undefined
  const content = await FileView.file(filepath)
    .text()
    .catch(() => undefined)
  if (content === undefined) return undefined
  if (!content) return 0
  return content.split(/\r?\n/).length
}

async function build(): Promise<WorkspaceFile.StatusSummary> {
  const cwd = root()
  if (!FileView.native() && !EnvironmentResources.current()?.runtime)
    return { files: [], capability: { available: false, reason: "Git status requires a live Environment" } }
  const git = (args: string[]) =>
    WorktreeProcess.run({
      command: ["git", ...args],
      directory: cwd,
      roots: [],
      metadata: true,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    })
  const [diff, untracked] = await Promise.all([
    git([
      "diff",
      "--raw",
      "--numstat",
      "-M",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      "-z",
      "HEAD",
      "--",
      ".",
    ]).then((result) => result.stdout.toString()),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]).then((result) => result.stdout.toString()),
  ])
  const files = new Map<string, WorkspaceFile.StatusSummary["files"][number]>()
  const records = diff.split("\0")
  for (let i = 0; i < records.length; ) {
    const record = records[i++]!
    if (record.startsWith(":")) {
      const code = record.slice(record.lastIndexOf(" ") + 1)
      const oldPath = records[i++] ?? ""
      const filepath = cleanRelative(code.startsWith("R") ? (records[i++] ?? "") : oldPath)
      if (filepath) files.set(filepath, { path: filepath, status: parseStatus(code) })
      continue
    }
    const first = record.indexOf("\t")
    const second = record.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    let filepath = record.slice(second + 1)
    if (!filepath) {
      i++
      filepath = records[i++] ?? ""
    }
    const file = files.get(cleanRelative(filepath))
    if (!file) continue
    file.added = Number.parseInt(record.slice(0, first), 10) || 0
    file.removed = Number.parseInt(record.slice(first + 1, second), 10) || 0
  }

  const untrackedFiles = untracked.split("\0").filter(Boolean)
  const shouldCountUntrackedLines = untrackedFiles.length <= MAX_UNTRACKED_LINE_COUNT_FILES
  for (let offset = 0; offset < untrackedFiles.length; offset += 16) {
    await Promise.all(
      untrackedFiles.slice(offset, offset + 16).map(async (filepath) => {
        const relative = cleanRelative(filepath)
        const added = shouldCountUntrackedLines ? await lineCount(path.join(cwd, relative)) : undefined
        files.set(relative, {
          path: relative,
          status: "untracked",
          ...(added === undefined ? {} : { added, removed: 0 }),
        })
      }),
    )
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
        const sync = { epoch: Bus.epoch(), seq: Bus.currentSeq() }
        const summary = { ...(await build()), sync, generatedAt: Date.now() }
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

  export function cachedStatusMap(): ReadonlyMap<string, WorkspaceFile.GitStatus> | undefined {
    return state().peek()?.byPath
  }
}
