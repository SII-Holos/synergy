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

  function abortedGitResult(): { exitCode: number; text: string; stderr: string } {
    return { exitCode: -1, text: "", stderr: "" }
  }

  function abortError(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason
    return new DOMException("Snapshot git command aborted", "AbortError")
  }

  function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        promise.catch(() => {})
        reject(abortError(signal))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      )
    })
  }

  async function gitSpawn(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<{ exitCode: number; text: string; stderr: string }> {
    if (signal?.aborted) return abortedGitResult()
    const childSignal = spawnSignal(SNAPSHOT_TIMEOUT_MS, signal)
    let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> | undefined
    try {
      proc = Bun.spawn(args, {
        cwd,
        stdin: stdin === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: env ? { ...process.env, ...env } : process.env,
        signal: childSignal.signal,
      })
      if (stdin !== undefined) {
        if (!proc.stdin) throw new Error("git subprocess stdin pipe unavailable")
        proc.stdin.write(stdin)
        proc.stdin.end()
      }
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text().catch(() => "")
      const [text, stderrText, exitCode] = await withTimeout(
        withAbort(Promise.all([stdout, stderr, proc.exited]), childSignal.signal),
        SNAPSHOT_HARD_TIMEOUT_MS,
        { message: `git subprocess did not settle within ${SNAPSHOT_HARD_TIMEOUT_MS}ms` },
      )
      return { exitCode, text, stderr: stderrText }
    } catch (err) {
      if (signal?.aborted) {
        try {
          proc?.kill()
        } catch {}
        return abortedGitResult()
      }
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
    if (signal?.aborted) return
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
      await gitSpawn(
        ["git", "--git-dir", git, "config", "core.quotepath", "false"],
        ScopeContext.current.directory,
        undefined,
        signal,
      )
      log.info("initialized")
    }
    await ensureExclude(git)
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
    if (opts?.signal?.aborted) return { hash, files: [] }
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
    if (opts?.signal?.aborted) return { hash, files: [] }
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
    const diff = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.quotepath=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        "-p",
        from,
        to,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (diff.exitCode !== 0) {
      log.warn("failed to get diff summary", { from, to, exitCode: diff.exitCode, stderr: diff.stderr })
      return result
    }

    const parsed = parseNumstatPatch(diff.text)
    const sizes = await objectSizes(
      git,
      parsed.stats.flatMap((stat) => [
        { tree: from, file: stat.file },
        { tree: to, file: stat.file },
      ]),
      signal,
    )
    for (let index = 0; index < parsed.stats.length; index++) {
      const stat = parsed.stats[index]
      const { additions, deletions, file } = stat
      const isBinaryFile = additions === "-" && deletions === "-"
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      const patch = isBinaryFile ? "" : (parsed.patches[index] ?? "")
      result.push(
        SnapshotSchema.fromPatch({
          file,
          additions: Number.isFinite(added) ? added : 0,
          deletions: Number.isFinite(deleted) ? deleted : 0,
          binary: isBinaryFile,
          patch,
          beforeBytes: sizes.get(objectSizeKey(from, file)),
          afterBytes: sizes.get(objectSizeKey(to, file)),
        }),
      )
    }
    return result
  }

  async function refreshIndex(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    const git = gitdir(sessionID)
    const cwd = ScopeContext.current.directory
    await ensureExclude(git)

    const changed = await changedFiles(git, cwd, signal)
    if (changed === undefined) return false
    if (changed.length === 0) return true

    const addable: string[] = []
    const removable: string[] = []
    for (const rel of changed) {
      const state = await candidateState(cwd, rel)
      if (state === "missing") {
        addable.push(rel)
        continue
      }
      if (state === "add") {
        addable.push(rel)
        continue
      }
      removable.push(rel)
    }

    if (removable.length > 0) {
      const pathspec = path.join(git, "synergy-remove-pathspec")
      await fs.writeFile(pathspec, removable.join("\0") + "\0")
      try {
        const rm = await gitSpawn(
          [
            "git",
            "--git-dir",
            git,
            "--work-tree",
            cwd,
            "rm",
            "--cached",
            "--ignore-unmatch",
            "-r",
            "--pathspec-from-file",
            pathspec,
            "--pathspec-file-nul",
          ],
          cwd,
          undefined,
          signal,
        )
        if (rm.exitCode !== 0) return false
      } finally {
        await fs.unlink(pathspec).catch(() => undefined)
      }
    }

    if (addable.length === 0) return true

    const pathspec = path.join(git, "synergy-pathspec")
    await fs.writeFile(pathspec, addable.join("\0") + "\0")
    try {
      const add = await gitSpawn(
        [
          "git",
          "--git-dir",
          git,
          "--work-tree",
          cwd,
          "add",
          "--all",
          "--pathspec-from-file",
          pathspec,
          "--pathspec-file-nul",
        ],
        cwd,
        undefined,
        signal,
      )
      return add.exitCode === 0
    } finally {
      await fs.unlink(pathspec).catch(() => undefined)
    }
  }

  async function changedFiles(git: string, cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const status = await gitSpawn(
      [
        "git",
        "-c",
        "core.quotepath=false",
        "--git-dir",
        git,
        "--work-tree",
        cwd,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      cwd,
      undefined,
      signal,
    )
    if (status.exitCode !== 0) {
      log.warn("status failed", { cwd, exitCode: status.exitCode, stderr: status.stderr })
      return undefined
    }
    const files = new Set<string>()
    const items = status.text.split("\0")
    for (let index = 0; index < items.length; index++) {
      const raw = items[index]
      if (!raw) continue
      const code = raw.slice(0, 2)
      const rel = raw.slice(3).trim()
      if (rel) files.add(rel.replaceAll("\\", "/"))
      if (code.includes("R") || code.includes("C")) {
        const previous = items[++index]?.trim()
        if (previous) files.add(previous.replaceAll("\\", "/"))
      }
    }
    return [...files]
  }

  async function candidateState(cwd: string, rel: string): Promise<"add" | "remove" | "missing"> {
    if (excludePath(rel)) return "remove"
    const absolute = path.join(cwd, rel)
    const stat = await fs.lstat(absolute).catch(() => undefined)
    if (!stat) return "missing"
    if (!stat.isFile() && !stat.isSymbolicLink()) return "remove"
    if (stat.isFile() && stat.size > SNAPSHOT_MAX_FILE_BYTES) return "remove"
    return "add"
  }

  function excludePath(rel: string): boolean {
    const normalized = rel.replaceAll("\\", "/")
    const segments = normalized.split("/")
    if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return true
    return EXCLUDED_EXTENSIONS.has(path.extname(normalized).toLowerCase())
  }

  async function ensureExclude(git: string) {
    const info = path.join(git, "info")
    await fs.mkdir(info, { recursive: true })
    const body = [
      "# Synergy snapshot exclusions",
      ...[...EXCLUDED_DIRS].sort().map((dir) => `${dir}/`),
      ...[...EXCLUDED_EXTENSIONS].sort().map((extension) => `*${extension}`),
      "",
    ].join("\n")
    const file = path.join(info, "exclude")
    const current = await fs.readFile(file, "utf8").catch(() => undefined)
    if (current !== body) await fs.writeFile(file, body)
  }

  function absoluteWorktreePath(rel: string): string {
    return `${ScopeContext.current.directory}/${rel.replaceAll("\\", "/")}`
  }

  function parseNumstatPatch(text: string): {
    stats: Array<{ additions: string; deletions: string; file: string }>
    patches: string[]
  } {
    const marker = "\n\ndiff --git "
    const markerIndex = text.indexOf(marker)
    const numstatText = markerIndex === -1 ? text : text.slice(0, markerIndex)
    const patchText = markerIndex === -1 ? "" : text.slice(markerIndex + 2)
    return {
      stats: numstatText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, file] = line.split("\t")
          return { additions, deletions, file }
        }),
      patches: splitPatches(patchText),
    }
  }

  function splitPatches(text: string) {
    if (!text.trim()) return []
    return text
      .split(/^diff --git /m)
      .filter(Boolean)
      .map((patch) => `diff --git ${patch}`)
  }

  function objectSizeKey(tree: string, file: string) {
    return `${tree}:${file}`
  }

  async function objectSizes(
    git: string,
    objects: Array<{ tree: string; file: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (objects.length === 0) return result
    const input = objects.map((object) => objectSizeKey(object.tree, object.file)).join("\n") + "\n"
    const batch = await gitSpawn(
      ["git", "--git-dir", git, "cat-file", "--batch-check=%(objectsize)"],
      ScopeContext.current.directory,
      undefined,
      signal,
      input,
    )
    if (batch.exitCode !== 0) return result
    const lines = batch.text.split("\n")
    for (let index = 0; index < objects.length; index++) {
      const line = lines[index]?.trim() ?? ""
      if (!/^\d+$/.test(line)) continue
      const parsed = Number.parseInt(line, 10)
      if (Number.isFinite(parsed)) result.set(objectSizeKey(objects[index].tree, objects[index].file), parsed)
    }
    return result
  }

  function gitdir(sessionID: string) {
    const scope = ScopeContext.current.scope
    return path.join(Global.Path.snapshot, scope.id, sessionID)
  }
}
