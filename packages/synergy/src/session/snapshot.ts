import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import z from "zod"
import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"
import { SnapshotSchema } from "./snapshot-schema"
import { withTimeout } from "../util/timeout"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const SNAPSHOT_TIMEOUT_MS = 10_000
  // Extra headroom past the abort timeout: the abort signal can only kill the
  // child process — it cannot rescue a stdout/exit collection promise that
  // never settles, so the whole collection is raced against this deadline.
  const SNAPSHOT_HARD_TIMEOUT_MS = SNAPSHOT_TIMEOUT_MS + 5_000
  const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024
  const EXCLUDED_DIRS = new Set([
    ".git",
    ".synergy",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
  ])
  const EXCLUDED_EXTENSIONS = new Set([
    ".zip",
    ".7z",
    ".rar",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".bin",
    ".exe",
    ".dll",
    ".dylib",
    ".so",
    ".lock",
  ])

  function spawnSignal(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException("Snapshot git command timed out", "TimeoutError")),
      timeoutMs,
    )
    let onAbort: (() => void) | undefined
    const cleanup = () => {
      clearTimeout(timer)
      if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort)
    }
    if (parentSignal) {
      if (parentSignal.aborted) {
        cleanup()
        return { signal: AbortSignal.abort(parentSignal.reason), cleanup }
      }
      onAbort = () => {
        cleanup()
        controller.abort(parentSignal.reason)
      }
      parentSignal.addEventListener("abort", onAbort, { once: true })
    }
    controller.signal.addEventListener("abort", cleanup, { once: true })
    return { signal: controller.signal, cleanup }
  }

  async function gitSpawn(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; text: string; stderr: string }> {
    const childSignal = spawnSignal(SNAPSHOT_TIMEOUT_MS, signal)
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
    try {
      proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: env ? { ...process.env, ...env } : process.env,
        signal: childSignal.signal,
      })
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text().catch(() => "")
      const [text, stderrText, exitCode] = await withTimeout(
        Promise.all([stdout, stderr, proc.exited]),
        SNAPSHOT_HARD_TIMEOUT_MS,
        { message: `git subprocess did not settle within ${SNAPSHOT_HARD_TIMEOUT_MS}ms` },
      )
      return { exitCode, text, stderr: stderrText }
    } catch (err) {
      log.warn("git spawn failed", { args, cwd, error: String(err) })
      try {
        proc?.kill()
      } catch {}
      return { exitCode: -1, text: "", stderr: "" }
    } finally {
      childSignal.cleanup()
    }
  }

  export async function track(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (ScopeContext.current.scope.type !== "project" || ScopeContext.current.scope.vcs !== "git") return
    const cfg = await Config.current()
    if (cfg.snapshot === false) return
    const started = Date.now()
    log.debug("track start", { sessionID, cwd: ScopeContext.current.directory })
    const git = gitdir(sessionID)
    if (await fs.mkdir(git, { recursive: true })) {
      const initResult = await gitSpawn(
        ["git", "init"],
        ScopeContext.current.directory,
        { GIT_DIR: git, GIT_WORK_TREE: ScopeContext.current.directory },
        signal,
      )
      if (initResult.exitCode !== 0) {
        log.warn("track init failed", { sessionID, exitCode: initResult.exitCode, duration: Date.now() - started })
        return undefined
      }
      await gitSpawn(
        ["git", "--git-dir", git, "config", "core.autocrlf", "false"],
        ScopeContext.current.directory,
        undefined,
        signal,
      )
      log.info("initialized")
    }
    const addResult = await refreshIndex(sessionID, signal)
    if (!addResult) {
      log.warn("track add failed", { sessionID, duration: Date.now() - started })
      return undefined
    }
    const writeResult = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", ScopeContext.current.directory, "write-tree"],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (writeResult.exitCode !== 0 || !writeResult.text.trim()) {
      log.warn("track write-tree failed", { sessionID, exitCode: writeResult.exitCode, duration: Date.now() - started })
      return undefined
    }
    const hash = writeResult.text.trim()
    log.info("tracking", { hash, cwd: ScopeContext.current.directory, git, duration: Date.now() - started })
    return hash
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export async function patch(
    hash: string,
    sessionID: string,
    opts?: { indexFresh?: boolean; signal?: AbortSignal },
  ): Promise<Patch> {
    const started = Date.now()
    log.debug("patch start", { sessionID, hash })
    const git = gitdir(sessionID)
    if (!opts?.indexFresh) {
      const addResult = await refreshIndex(sessionID, opts?.signal)
      if (!addResult) {
        log.warn("patch add failed", { sessionID, hash, duration: Date.now() - started })
        return { hash, files: [] }
      }
    }
    const diffResult = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        "--name-only",
        hash,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (diffResult.exitCode !== 0) {
      log.warn("failed to get diff", {
        sessionID,
        hash,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr,
        duration: Date.now() - started,
      })
      return { hash, files: [] }
    }

    const filesText = diffResult.text
    log.debug("patch done", { sessionID, hash, duration: Date.now() - started })
    return {
      hash,
      files: filesText
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => absoluteWorktreePath(x)),
    }
  }

  export async function restore(snapshot: string, sessionID: string) {
    log.info("restore", { snapshot, sessionID })
    const git = gitdir(sessionID)
    let all
    try {
      const { Session } = await import(".")
      all = await Session.messages({ sessionID, raw: true })
    } catch {
      // session not found — no patches to restore, no-op
      return
    }
    const seen = new Set<string>()
    for (const msg of all) {
      for (const part of msg.parts) {
        if (part.type !== "patch") continue
        for (const file of part.files) {
          if (seen.has(file)) continue
          seen.add(file)
          const relativePath = path.relative(ScopeContext.current.directory, file).replaceAll("\\", "/")
          const result = await gitSpawn(
            [
              "git",
              "--git-dir",
              git,
              "--work-tree",
              ScopeContext.current.directory,
              "checkout",
              snapshot,
              "--",
              relativePath,
            ],
            ScopeContext.current.directory,
          )
          if (result.exitCode !== 0) {
            log.warn("failed to restore file from snapshot", {
              file,
              snapshot,
              stderr: result.stderr,
            })
          }
        }
      }
    }
  }

  export async function revert(patches: Patch[], sessionID: string) {
    const files = new Set<string>()
    const git = gitdir(sessionID)
    for (const item of patches) {
      for (const file of item.files) {
        if (files.has(file)) continue
        log.info("reverting", { file, hash: item.hash })
        const relativePath = path.relative(ScopeContext.current.directory, file).replaceAll("\\", "/")
        const checkTree = await gitSpawn(
          [
            "git",
            "--git-dir",
            git,
            "--work-tree",
            ScopeContext.current.directory,
            "ls-tree",
            item.hash,
            "--",
            relativePath,
          ],
          ScopeContext.current.directory,
        )
        if (checkTree.exitCode === 0) {
          if (checkTree.text.trim()) {
            // File existed in snapshot — restore it
            const result = await gitSpawn(
              [
                "git",
                "--git-dir",
                git,
                "--work-tree",
                ScopeContext.current.directory,
                "checkout",
                item.hash,
                "--",
                relativePath,
              ],
              ScopeContext.current.directory,
            )
            if (result.exitCode !== 0) {
              log.warn("file existed in snapshot but checkout failed", {
                file,
                stderr: result.stderr,
              })
            }
          } else {
            // ls-tree succeeded but returned empty — file did not exist in snapshot
            log.info("file did not exist in snapshot, deleting", { file })
            await fs.unlink(file).catch(() => {})
          }
        } else {
          // ls-tree failed — don't delete; we can't confirm the file's status
          log.warn("ls-tree failed, skipping revert for file", {
            file,
            exitCode: checkTree.exitCode,
            stderr: checkTree.stderr,
          })
        }
        files.add(file)
      }
    }
  }

  export async function diff(hash: string, sessionID: string, opts?: { indexFresh?: boolean; signal?: AbortSignal }) {
    const git = gitdir(sessionID)
    if (!opts?.indexFresh) await refreshIndex(sessionID, opts?.signal)
    const result = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        hash,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.text,
      })
      return ""
    }

    return result.text.trim()
  }

  export const FileDiff = SnapshotSchema.FileDiff
  export type FileDiff = SnapshotSchema.FileDiff
  export async function diffSummary(
    from: string,
    to: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<FileDiff[]> {
    const git = gitdir(sessionID)
    const result: FileDiff[] = []
    const numstat = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        from,
        to,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (numstat.exitCode !== 0) {
      log.warn("failed to get diff summary", { from, to, exitCode: numstat.exitCode, stderr: numstat.stderr })
      return result
    }
    for (const line of numstat.text.split("\n")) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      const isBinaryFile = additions === "-" && deletions === "-"
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      const patch = isBinaryFile
        ? ""
        : (
            await gitSpawn(
              [
                "git",
                "-c",
                "core.autocrlf=false",
                "--git-dir",
                git,
                "--work-tree",
                ScopeContext.current.directory,
                "diff",
                "--no-ext-diff",
                "--no-renames",
                from,
                to,
                "--",
                file,
              ],
              ScopeContext.current.directory,
              undefined,
              signal,
            )
          ).text
      result.push(
        SnapshotSchema.fromPatch({
          file,
          additions: Number.isFinite(added) ? added : 0,
          deletions: Number.isFinite(deleted) ? deleted : 0,
          binary: isBinaryFile,
          patch,
          beforeBytes: await objectSize(git, from, file, signal),
          afterBytes: await objectSize(git, to, file, signal),
        }),
      )
    }
    return result
  }

  async function refreshIndex(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    const git = gitdir(sessionID)
    const cwd = ScopeContext.current.directory
    const rm = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", cwd, "rm", "-r", "--cached", "--ignore-unmatch", "-f", "."],
      cwd,
      undefined,
      signal,
    )
    if (rm.exitCode !== 0) return false

    const files = await includedFiles(cwd, signal)
    if (files === undefined) return false
    if (files.length === 0) return true

    const pathspec = path.join(git, "synergy-pathspec")
    await fs.writeFile(pathspec, files.join("\0") + "\0")
    try {
      const add = await gitSpawn(
        ["git", "--git-dir", git, "--work-tree", cwd, "add", "--pathspec-from-file", pathspec, "--pathspec-file-nul"],
        cwd,
        undefined,
        signal,
      )
      return add.exitCode === 0
    } finally {
      await fs.unlink(pathspec).catch(() => undefined)
    }
  }

  async function includedFiles(cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const listing = await gitSpawn(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd, undefined, signal)
    if (listing.exitCode !== 0) {
      log.warn("ls-files failed", { cwd, exitCode: listing.exitCode, stderr: listing.stderr })
      return undefined
    }
    const files: string[] = []
    for (const raw of listing.text.split("\0")) {
      const rel = raw.trim()
      if (!rel || excludePath(rel)) continue
      const absolute = path.join(cwd, rel)
      const stat = await fs.lstat(absolute).catch(() => undefined)
      if (!stat?.isFile() && !stat?.isSymbolicLink()) continue
      if (stat.isFile() && stat.size > SNAPSHOT_MAX_FILE_BYTES) continue
      files.push(rel.replaceAll("\\", "/"))
    }
    return files
  }

  function excludePath(rel: string): boolean {
    const normalized = rel.replaceAll("\\", "/")
    const segments = normalized.split("/")
    if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return true
    return EXCLUDED_EXTENSIONS.has(path.extname(normalized).toLowerCase())
  }

  function absoluteWorktreePath(rel: string): string {
    return `${ScopeContext.current.directory}/${rel.replaceAll("\\", "/")}`
  }

  async function objectSize(git: string, tree: string, file: string, signal?: AbortSignal): Promise<number | undefined> {
    const result = await gitSpawn(
      ["git", "--git-dir", git, "cat-file", "-s", `${tree}:${file}`],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (result.exitCode !== 0) return undefined
    const parsed = Number.parseInt(result.text.trim(), 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  function gitdir(sessionID: string) {
    const scope = ScopeContext.current.scope
    return path.join(Global.Path.snapshot, scope.id, sessionID)
  }
}
