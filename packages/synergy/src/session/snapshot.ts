import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import z from "zod"
import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const SNAPSHOT_TIMEOUT_MS = 10_000

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
  ): Promise<{ exitCode: number; text: string }> {
    const childSignal = spawnSignal(SNAPSHOT_TIMEOUT_MS, signal)
    try {
      const proc = Bun.spawn(args, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: env ? { ...process.env, ...env } : process.env,
        signal: childSignal.signal,
      })
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text().catch(() => "")
      const [text, exitCode] = await Promise.all([stdout, proc.exited])
      await stderr
      return { exitCode, text }
    } catch (err) {
      log.debug("git spawn failed", { args, cwd, error: String(err) })
      return { exitCode: -1, text: "" }
    } finally {
      childSignal.cleanup()
    }
  }

  export async function track(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (ScopeContext.current.scope.type !== "project" || ScopeContext.current.scope.vcs !== "git") return
    const cfg = await Config.current()
    if (cfg.snapshot === false) return
    const git = gitdir(sessionID)
    if (await fs.mkdir(git, { recursive: true })) {
      const initResult = await gitSpawn(
        ["git", "init"],
        ScopeContext.current.directory,
        { GIT_DIR: git, GIT_WORK_TREE: ScopeContext.current.directory },
        signal,
      )
      if (initResult.exitCode !== 0) {
        log.warn("track init failed", { exitCode: initResult.exitCode })
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
    const addResult = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", ScopeContext.current.directory, "add", "."],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (addResult.exitCode !== 0) {
      log.warn("track add failed", { exitCode: addResult.exitCode })
      return undefined
    }
    const writeResult = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", ScopeContext.current.directory, "write-tree"],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (writeResult.exitCode !== 0 || !writeResult.text.trim()) {
      log.warn("track write-tree failed", { exitCode: writeResult.exitCode })
      return undefined
    }
    const hash = writeResult.text.trim()
    log.info("tracking", { hash, cwd: ScopeContext.current.directory, git })
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
    const git = gitdir(sessionID)
    if (!opts?.indexFresh) {
      const addResult = await gitSpawn(
        ["git", "--git-dir", git, "--work-tree", ScopeContext.current.directory, "add", "."],
        ScopeContext.current.directory,
        undefined,
        opts?.signal,
      )
      if (addResult.exitCode !== 0) {
        log.warn("patch add failed", { hash, exitCode: addResult.exitCode })
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
      log.warn("failed to get diff", { hash, exitCode: diffResult.exitCode })
      return { hash, files: [] }
    }

    const filesText = diffResult.text
    return {
      hash,
      files: filesText
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.join(ScopeContext.current.directory, x)),
    }
  }

  export async function restore(snapshot: string, sessionID: string) {
    log.info("restore", { snapshot, sessionID })
    const git = gitdir(sessionID)
    let all
    try {
      const { Session } = await import(".")
      all = await Session.messages({ sessionID })
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
          const result =
            await $`git --git-dir ${git} --work-tree ${ScopeContext.current.directory} checkout ${snapshot} -- ${relativePath}`
              .quiet()
              .cwd(ScopeContext.current.directory)
              .nothrow()
          if (result.exitCode !== 0) {
            log.warn("failed to restore file from snapshot", {
              file,
              snapshot,
              stderr: result.stderr.toString(),
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
        const checkTree =
          await $`git --git-dir ${git} --work-tree ${ScopeContext.current.directory} ls-tree ${item.hash} -- ${relativePath}`
            .quiet()
            .cwd(ScopeContext.current.directory)
            .nothrow()
        if (checkTree.exitCode === 0) {
          if (checkTree.text().trim()) {
            // File existed in snapshot — restore it
            const result =
              await $`git --git-dir ${git} --work-tree ${ScopeContext.current.directory} checkout ${item.hash} -- ${relativePath}`
                .quiet()
                .cwd(ScopeContext.current.directory)
                .nothrow()
            if (result.exitCode !== 0) {
              log.warn("file existed in snapshot but checkout failed", {
                file,
                stderr: result.stderr.toString(),
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
            stderr: checkTree.stderr.toString(),
          })
        }
        files.add(file)
      }
    }
  }

  export async function diff(hash: string, sessionID: string, opts?: { indexFresh?: boolean }) {
    const git = gitdir(sessionID)
    if (!opts?.indexFresh)
      await $`git --git-dir ${git} --work-tree ${ScopeContext.current.directory} add .`
        .quiet()
        .cwd(ScopeContext.current.directory)
        .nothrow()
    const result =
      await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${ScopeContext.current.directory} diff --no-ext-diff ${hash} -- .`
        .quiet()
        .cwd(ScopeContext.current.directory)
        .nothrow()

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return ""
    }

    return result.text().trim()
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  export async function diffFull(from: string, to: string, sessionID: string): Promise<FileDiff[]> {
    const git = gitdir(sessionID)
    const result: FileDiff[] = []
    for await (const line of $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${ScopeContext.current.directory} diff --no-ext-diff --no-renames --numstat ${from} ${to} -- .`
      .quiet()
      .cwd(ScopeContext.current.directory)
      .nothrow()
      .lines()) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      const isBinaryFile = additions === "-" && deletions === "-"
      const before = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${ScopeContext.current.directory} show ${from}:${file}`
            .quiet()
            .nothrow()
            .text()
      const after = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${ScopeContext.current.directory} show ${to}:${file}`
            .quiet()
            .nothrow()
            .text()
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      result.push({
        file,
        before,
        after,
        additions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(deleted) ? deleted : 0,
      })
    }
    return result
  }

  function gitdir(sessionID: string) {
    const scope = ScopeContext.current.scope
    return path.join(Global.Path.snapshot, scope.id, sessionID)
  }
}
