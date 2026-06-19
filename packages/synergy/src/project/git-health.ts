import { $ } from "bun"
import path from "path"
import fs from "fs"

export namespace GitHealth {
  export interface Issue {
    dimension:
      | "diff_lines"
      | "diff_files"
      | "untracked"
      | "large_files"
      | "extra_branches"
      | "detached_head"
      | "gc_needed"
    level: "warn" | "critical"
    message: string
    detail: Record<string, unknown>
  }

  // ---------------------------------------------------------------------------
  // Cache — per-directory with 5-minute TTL
  // ---------------------------------------------------------------------------
  const _cache = new Map<string, { issues: Issue[]; ts: number }>()
  let _lastDir: string | undefined
  const CACHE_TTL_MS = 5 * 60 * 1000

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function isGitRepo(cwd: string): boolean {
    return fs.existsSync(path.join(cwd, ".git"))
  }

  function parseNumstat(text: string): { additions: number; deletions: number; files: Set<string> } {
    let additions = 0
    let deletions = 0
    const files = new Set<string>()

    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split("\t")
      const add = parseInt(parts[0])
      const del = parseInt(parts[1])
      if (!isNaN(add)) additions += add
      if (!isNaN(del)) deletions += del
      if (parts.length >= 3 && parts[2]) files.add(parts[2])
    }

    return { additions, deletions, files }
  }

  function countLooseObjectsOnDisk(cwd: string): number {
    const objectsDir = path.join(cwd, ".git", "objects")
    let count = 0
    try {
      for (const entry of fs.readdirSync(objectsDir)) {
        if (entry === "pack" || entry === "info") continue
        const subDir = path.join(objectsDir, entry)
        const subStat = fs.statSync(subDir, { throwIfNoEntry: false })
        if (subStat?.isDirectory()) {
          count += fs.readdirSync(subDir).length
        }
      }
    } catch {}
    return count
  }

  // ---------------------------------------------------------------------------
  // Dimensions 1+2: diff_lines and diff_files (single pass)
  // diff_lines thresholds: 200→warn, 800→critical
  // diff_files thresholds: 10→warn, 25→critical
  // ---------------------------------------------------------------------------
  async function checkDiff(cwd: string): Promise<Issue[]> {
    const [unstaged, staged] = await Promise.all([
      $`git diff --numstat HEAD`
        .quiet()
        .nothrow()
        .cwd(cwd)
        .text()
        .catch(() => ""),
      $`git diff --cached --numstat HEAD`
        .quiet()
        .nothrow()
        .cwd(cwd)
        .text()
        .catch(() => ""),
    ])

    const unstagedParsed = parseNumstat(unstaged)
    const stagedParsed = parseNumstat(staged)

    const issues: Issue[] = []

    // diff_lines
    const unstagedLines = unstagedParsed.additions + unstagedParsed.deletions
    const stagedLines = stagedParsed.additions + stagedParsed.deletions
    const total = unstagedLines + stagedLines

    if (total >= 200) {
      issues.push({
        dimension: "diff_lines",
        level: total >= 800 ? "critical" : "warn",
        message: `${total} lines of uncommitted changes — commit now to avoid losing work`,
        detail: { lines: total, staged: stagedLines, unstaged: unstagedLines },
      })
    }

    // diff_files
    const allFiles = new Set([...unstagedParsed.files, ...stagedParsed.files])
    const count = allFiles.size

    if (count >= 10) {
      issues.push({
        dimension: "diff_files",
        level: count >= 25 ? "critical" : "warn",
        message: `${count} files modified but not committed — split into focused commits while intent is fresh`,
        detail: { files: count },
      })
    }

    return issues
  }

  // ---------------------------------------------------------------------------
  // Dimension 3: untracked
  // Thresholds: 15→warn, 80→critical
  // ---------------------------------------------------------------------------
  async function checkUntracked(cwd: string): Promise<Issue | undefined> {
    const result = await $`git ls-files --others --exclude-standard`
      .quiet()
      .nothrow()
      .cwd(cwd)
      .text()
      .catch(() => "")

    const trimmed = result.trim()
    const count = trimmed ? trimmed.split("\n").length : 0

    if (count < 15) return undefined

    const level: Issue["level"] = count >= 80 ? "critical" : "warn"

    return {
      dimension: "untracked",
      level,
      message: `${count} untracked files — review with git status: add, ignore, or clean up`,
      detail: { count },
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension 4: large_files
  // Thresholds: >10MB→warn, >50MB→critical
  // ---------------------------------------------------------------------------
  async function checkLargeFiles(cwd: string): Promise<Issue | undefined> {
    const result = await $`git ls-files -z`
      .quiet()
      .nothrow()
      .cwd(cwd)
      .text()
      .catch(() => "")

    const fileNames = result.split("\0").filter(Boolean)
    if (fileNames.length === 0) return undefined
    // Cap to avoid dominating check time on repos with hundreds of thousands of files.
    const cappedNames = fileNames.length > 10000 ? fileNames.slice(0, 10000) : fileNames
    if (cappedNames.length === 0) return undefined

    const large: { path: string; size: number }[] = []

    for (const fileName of cappedNames) {
      const filePath = path.join(cwd, fileName)
      const stat = await Bun.file(filePath)
        .stat()
        .catch(() => undefined)
      if (stat && stat.size > 10 * 1024 * 1024) {
        large.push({ path: fileName, size: stat.size })
      }
    }

    if (large.length === 0) return undefined

    large.sort((a, b) => b.size - a.size)
    const largest = large[0]

    const level: Issue["level"] = largest.size >= 50 * 1024 * 1024 ? "critical" : "warn"

    return {
      dimension: "large_files",
      level,
      message: `${large.length} large file(s) tracked — largest is ${largest.path} (${Math.round(largest.size / (1024 * 1024))}MB). If committed by accident, add to .gitignore and remove from tracking`,
      detail: {
        count: large.length,
        largest: largest.path,
        largestSize: largest.size,
        files: large.slice(0, 5).map((f) => f.path),
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension 5: extra_branches
  // Thresholds: 10→warn, 40→critical
  // ---------------------------------------------------------------------------
  async function checkExtraBranches(cwd: string): Promise<Issue | undefined> {
    const [headBranch, branchesText] = await Promise.all([
      $`git rev-parse --abbrev-ref HEAD`
        .quiet()
        .nothrow()
        .cwd(cwd)
        .text()
        .then((x) => x.trim())
        .catch(() => ""),
      $`git for-each-ref --format='%(refname:short)' refs/heads/`
        .quiet()
        .nothrow()
        .cwd(cwd)
        .text()
        .catch(() => ""),
    ])

    const branches = branchesText.trim().split("\n").filter(Boolean)
    if (branches.length === 0) return undefined

    const count = branches.filter((b) => b !== headBranch).length
    if (count < 10) return undefined

    const level: Issue["level"] = count >= 40 ? "critical" : "warn"

    return {
      dimension: "extra_branches",
      level,
      message: `${count} non-current branches — prune with git branch -d or archive`,
      detail: { count },
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension 6: detached_head
  // ---------------------------------------------------------------------------
  async function checkDetachedHead(cwd: string): Promise<Issue | undefined> {
    const symRef = await $`git symbolic-ref HEAD`.quiet().nothrow().cwd(cwd)
    if (symRef.exitCode === 0) return undefined

    const headCommit = await $`git rev-parse HEAD`
      .quiet()
      .nothrow()
      .cwd(cwd)
      .text()
      .then((x) => x.trim())
      .catch(() => "")
    if (!headCommit) return undefined

    return {
      dimension: "detached_head",
      level: "critical",
      message: "Detached HEAD — commits will be lost unless you create a branch",
      detail: { headCommit },
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension 7: gc_needed
  // Uses both git count-objects and filesystem count (max of the two).
  // git count-objects only counts valid objects; the filesystem fallback
  // catches hand-crafted test fixture objects.
  // Thresholds: 50→warn, 200→critical
  // ---------------------------------------------------------------------------
  async function checkGcNeeded(cwd: string): Promise<Issue | undefined> {
    const output = await $`git count-objects -v`
      .quiet()
      .nothrow()
      .cwd(cwd)
      .text()
      .catch(() => "")

    const countMatch = output.match(/count:\s*(\d+)/)
    const sizeMatch = output.match(/size:\s*(\d+)/)

    const gitCount = countMatch ? parseInt(countMatch[1]) : 0
    const diskCount = countLooseObjectsOnDisk(cwd)
    const looseObjects = Math.max(gitCount, diskCount)
    const size = sizeMatch ? parseInt(sizeMatch[1]) : 0

    if (looseObjects < 50) return undefined

    const level: Issue["level"] = looseObjects >= 200 ? "critical" : "warn"

    return {
      dimension: "gc_needed",
      level,
      message: `Git gc recommended — ${looseObjects} loose objects. Run git gc to reclaim space`,
      detail: { looseObjects, size },
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  export async function check(cwd?: string): Promise<Issue[]> {
    const dir = cwd ?? process.cwd()

    const cached = _cache.get(dir)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      _lastDir = dir
      return cached.issues
    }

    if (!isGitRepo(dir)) {
      _cache.set(dir, { issues: [], ts: Date.now() })
      _lastDir = dir
      return []
    }

    const results = await Promise.all([
      checkDiff(dir),
      checkUntracked(dir),
      checkLargeFiles(dir),
      checkExtraBranches(dir),
      checkDetachedHead(dir),
      checkGcNeeded(dir),
    ])

    const issues = results.flat().filter((i): i is Issue => i !== undefined)
    _cache.set(dir, { issues, ts: Date.now() })
    _lastDir = dir
    return issues
  }

  export async function inject(cwd?: string): Promise<string | undefined> {
    const issues = await check(cwd)
    const active = issues.filter((i) => i.level === "warn" || i.level === "critical")
    if (active.length === 0) return undefined

    const lines = ["<git-health>"]
    for (const issue of active) {
      const label = issue.level === "critical" ? "Critical" : "Warning"
      lines.push(`${label}: ${issue.message}`)
    }
    lines.push("</git-health>")
    return lines.join("\n")
  }

  export function lastReport(): Issue[] | undefined {
    if (!_lastDir) return undefined
    const cached = _cache.get(_lastDir)
    return cached?.issues.length ? cached.issues : undefined
  }

  export function invalidate(): void {
    _cache.clear()
    _lastDir = undefined
  }
}
