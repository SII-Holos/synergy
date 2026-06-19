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

  interface CacheEntry {
    issues: Issue[]
    ts: number
  }

  interface RepoInfo {
    root: string
    gitDir: string
  }

  // ---------------------------------------------------------------------------
  // Cache — per-directory with 5-minute TTL
  // ---------------------------------------------------------------------------
  const _cache = new Map<string, CacheEntry>()
  const _refreshing = new Map<string, Promise<Issue[]>>()
  const _aliases = new Map<string, string>()
  let _lastDir: string | undefined
  let _generation = 0
  const CACHE_TTL_MS = 5 * 60 * 1000
  const GIT_COMMAND_TIMEOUT_MS = 2_000
  const LARGE_FILE_STAT_BATCH_SIZE = 64

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function normalizeDir(cwd: string): string {
    return path.resolve(cwd)
  }

  function cacheKey(cwd: string): string {
    const dir = normalizeDir(cwd)
    return _aliases.get(dir) ?? dir
  }

  async function gitText(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(GIT_COMMAND_TIMEOUT_MS),
      })
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text().catch(() => "")
      const [output, exitCode] = await Promise.all([stdout, proc.exited])
      await stderr
      if (exitCode !== 0) return undefined
      return output
    } catch {
      return undefined
    }
  }

  async function resolveRepo(cwd: string): Promise<RepoInfo | undefined> {
    const dir = normalizeDir(cwd)
    const inside = await gitText(dir, ["rev-parse", "--is-inside-work-tree"])
    if (inside?.trim() !== "true") return undefined

    const [rootText, gitDirText] = await Promise.all([
      gitText(dir, ["rev-parse", "--show-toplevel"]),
      gitText(dir, ["rev-parse", "--git-dir"]),
    ])
    const root = rootText?.trim()
    const gitDir = gitDirText?.trim()
    if (!root || !gitDir) return undefined

    const resolvedRoot = normalizeDir(root)
    _aliases.set(dir, resolvedRoot)
    return {
      root: resolvedRoot,
      gitDir: path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir),
    }
  }

  function render(issues: Issue[]): string | undefined {
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

  function countLooseObjectsOnDisk(gitDir: string): number {
    const objectsDir = path.join(gitDir, "objects")
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
      gitText(cwd, ["diff", "--numstat", "HEAD"]).then((x) => x ?? ""),
      gitText(cwd, ["diff", "--cached", "--numstat", "HEAD"]).then((x) => x ?? ""),
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
    const result = (await gitText(cwd, ["ls-files", "--others", "--exclude-standard"])) ?? ""

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
    const result = (await gitText(cwd, ["ls-files", "-z"])) ?? ""

    const fileNames = result.split("\0").filter(Boolean)
    if (fileNames.length === 0) return undefined
    // Cap to avoid dominating check time on repos with hundreds of thousands of files.
    const cappedNames = fileNames.length > 10000 ? fileNames.slice(0, 10000) : fileNames
    if (cappedNames.length === 0) return undefined

    const large: { path: string; size: number }[] = []

    for (let i = 0; i < cappedNames.length; i += LARGE_FILE_STAT_BATCH_SIZE) {
      const batch = cappedNames.slice(i, i + LARGE_FILE_STAT_BATCH_SIZE)
      const stats = await Promise.all(
        batch.map(async (fileName) => {
          const filePath = path.join(cwd, fileName)
          const stat = await Bun.file(filePath)
            .stat()
            .catch(() => undefined)
          return stat ? { fileName, stat } : undefined
        }),
      )
      for (const result of stats) {
        if (result && result.stat.size > 10 * 1024 * 1024) {
          large.push({ path: result.fileName, size: result.stat.size })
        }
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
      gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then((x) => x?.trim() ?? ""),
      gitText(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).then((x) => x ?? ""),
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
    const symRef = await gitText(cwd, ["symbolic-ref", "HEAD"])
    if (symRef !== undefined) return undefined

    const headCommit = (await gitText(cwd, ["rev-parse", "HEAD"]))?.trim() ?? ""
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
  async function checkGcNeeded(cwd: string, gitDir: string): Promise<Issue | undefined> {
    const output = (await gitText(cwd, ["count-objects", "-v"])) ?? ""

    const countMatch = output.match(/count:\s*(\d+)/)
    const sizeMatch = output.match(/size:\s*(\d+)/)

    const gitCount = countMatch ? parseInt(countMatch[1]) : 0
    const diskCount = countLooseObjectsOnDisk(gitDir)
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

  async function scan(cwd: string): Promise<{ dir: string; issues: Issue[] }> {
    const fallbackDir = normalizeDir(cwd)
    const repo = await resolveRepo(fallbackDir)
    if (!repo) return { dir: fallbackDir, issues: [] }

    const results = await Promise.all([
      checkDiff(repo.root),
      checkUntracked(repo.root),
      checkLargeFiles(repo.root),
      checkExtraBranches(repo.root),
      checkDetachedHead(repo.root),
      checkGcNeeded(repo.root, repo.gitDir),
    ])

    const issues = results.flat().filter((i): i is Issue => i !== undefined)
    return { dir: repo.root, issues }
  }

  export function refresh(cwd?: string): Promise<Issue[]> {
    const inputDir = normalizeDir(cwd ?? process.cwd())
    const key = cacheKey(inputDir)
    const existing = _refreshing.get(key) ?? _refreshing.get(inputDir)
    if (existing) return existing

    const generation = _generation
    let promise!: Promise<Issue[]>
    promise = scan(inputDir)
      .then((result) => {
        _aliases.set(inputDir, result.dir)
        if (generation === _generation) {
          _cache.set(result.dir, { issues: result.issues, ts: Date.now() })
          _lastDir = result.dir
        }
        return result.issues
      })
      .catch(() => [])
      .finally(() => {
        if (_refreshing.get(key) === promise) _refreshing.delete(key)
        if (_refreshing.get(inputDir) === promise) _refreshing.delete(inputDir)
      })

    _refreshing.set(key, promise)
    if (key !== inputDir) _refreshing.set(inputDir, promise)
    return promise
  }

  export async function check(cwd?: string): Promise<Issue[]> {
    const dir = normalizeDir(cwd ?? process.cwd())
    const key = cacheKey(dir)
    const cached = _cache.get(key)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      _lastDir = key
      return cached.issues
    }
    return refresh(dir)
  }

  export async function inject(cwd?: string): Promise<string | undefined> {
    return render(await check(cwd))
  }

  export function injectCached(cwd?: string): string | undefined {
    const dir = normalizeDir(cwd ?? process.cwd())
    const key = cacheKey(dir)
    const cached = _cache.get(key)
    if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) {
      refresh(dir).catch(() => {})
    }
    if (!cached) return undefined
    _lastDir = key
    return render(cached.issues)
  }

  export function lastReport(): Issue[] | undefined {
    if (!_lastDir) return undefined
    const cached = _cache.get(_lastDir)
    return cached?.issues.length ? cached.issues : undefined
  }

  export function invalidate(cwd?: string): void {
    _generation++
    _refreshing.clear()
    if (cwd === undefined) {
      _cache.clear()
      _aliases.clear()
      _lastDir = undefined
      return
    }

    const dir = normalizeDir(cwd)
    const key = cacheKey(dir)
    _cache.delete(dir)
    _cache.delete(key)
    _aliases.delete(dir)
    if (_lastDir === dir || _lastDir === key) _lastDir = undefined
  }
}
