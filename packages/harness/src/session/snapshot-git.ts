import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { withTimeout } from "../util/timeout"
import path from "node:path"
import fs from "node:fs/promises"
import { SnapshotPath } from "./snapshot-path"

export namespace SnapshotGit {
  function command(args: string[]) {
    // Provenance: https://github.com/git-for-windows/git/blob/main/Documentation/config/core.adoc#corelongpaths
    // Snapshot stores and indexes are private and can exceed Windows MAX_PATH.
    // Apply before repository discovery, including initialization and transfers.
    return [args[0], "-c", "core.longpaths=true", "-c", "core.fsmonitor=false", ...args.slice(1)]
  }

  function startupDirectory(cwd: string, args: string[]) {
    if (process.platform !== "win32" || !args.includes("--git-dir")) return cwd
    // Git's startup getcwd precedes core.longpaths. Snapshot paths are absolute.
    return path.parse(path.resolve(cwd)).root
  }

  export async function* lines(repo: string, args: string[], options: { signal?: AbortSignal; input?: string } = {}) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
      : AbortSignal.timeout(30 * 60_000)
    signal.throwIfAborted()
    await using location = await SnapshotPath.repository(["git", "--git-dir", repo, ...args])
    const input = options.input ? await fs.open(options.input, "r") : undefined
    let proc: Bun.Subprocess<number | "ignore", "pipe", "pipe">
    try {
      proc = Bun.spawn(command(location.args), {
        cwd: startupDirectory(path.dirname(repo), ["--git-dir"]),
        env: environment(),
        stdout: "pipe",
        stderr: "pipe",
        stdin: input?.fd ?? "ignore",
        signal,
      })
    } catch (error) {
      await input?.close()
      throw error
    }
    const errors = tail(proc.stderr)
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      for (;;) {
        const chunk = await withAbort(reader.read(), signal)
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf("\n")) !== -1) {
          yield pending.slice(0, newline)
          pending = pending.slice(newline + 1)
        }
        if (pending.length > 1024 * 1024) throw new Error("Snapshot Git output line exceeds limit")
      }
      pending += decoder.decode()
      if (pending) yield pending
      const [code, stderr] = await withAbort(Promise.all([proc.exited, errors]), signal)
      if (code !== 0) throw new Error(`Snapshot git ${args[0]} failed: ${stderr.trim()}`)
    } finally {
      reader.releaseLock()
      if (proc.exitCode === null) proc.kill()
      await Promise.allSettled([proc.exited, errors])
      await input?.close()
    }
  }

  export async function checked(repo: string, args: string[], options: { signal?: AbortSignal; input?: string } = {}) {
    let output = ""
    for await (const line of lines(repo, args, options)) output = (output + line + "\n").slice(-16_384)
    return output.trim()
  }

  async function tail(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let result = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return result + decoder.decode()
        result = (result + decoder.decode(chunk.value, { stream: true })).slice(-16_384)
      }
    } finally {
      reader.releaseLock()
    }
  }

  export async function importObjects(
    source: string,
    target: string,
    inventory: string,
    signal?: AbortSignal,
    keepToken = "synergy-snapshot-transfer",
  ) {
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
      : AbortSignal.timeout(30 * 60_000)
    abort.throwIfAborted()
    const directory = await fs.mkdtemp(path.join(path.dirname(inventory), "pack-transfer-"))
    const filename = path.join(directory, "objects.pack")
    let pack: Bun.Subprocess<number, number, "pipe"> | undefined
    let errors: Promise<string> | undefined
    let input: Awaited<ReturnType<typeof fs.open>> | undefined
    let output: Awaited<ReturnType<typeof fs.open>> | undefined
    let location: Awaited<ReturnType<typeof SnapshotPath.repository>> | undefined
    try {
      location = await SnapshotPath.repository(["git", "--git-dir", source, "pack-objects", "--stdout"])
      input = await fs.open(inventory, "r")
      output = await fs.open(filename, "wx", 0o600)
      pack = Bun.spawn(command(location.args), {
        cwd: startupDirectory(path.dirname(source), ["--git-dir"]),
        env: environment(),
        stdin: input.fd,
        stdout: output.fd,
        stderr: "pipe",
        signal: abort,
      })
      errors = tail(pack.stderr)
      const [code, stderr] = await withAbort(Promise.all([pack.exited, errors]), abort)
      if (code !== 0) throw new Error(`Snapshot git pack-objects failed: ${stderr.trim()}`)
      await output.close()
      output = undefined
      const imported = await checked(target, ["index-pack", "--stdin", "--strict", `--keep=${keepToken}`], {
        signal: abort,
        input: filename,
      })
      const hash = imported.trim().split(/\s+/).at(-1)
      if (!hash || !/^[0-9a-f]{40}$/.test(hash)) throw new Error("Snapshot pack import did not report an object ID")
      return hash
    } finally {
      if (pack?.exitCode === null) pack.kill()
      await Promise.allSettled([pack?.exited, errors])
      await Promise.allSettled([input?.close(), output?.close()])
      await location?.[Symbol.asyncDispose]()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }

  const log = Log.create({ service: "snapshot" })
  const SNAPSHOT_TIMEOUT_MS = 10_000
  const SNAPSHOT_HARD_TIMEOUT_MS = SNAPSHOT_TIMEOUT_MS + 5_000
  const GIT_SPAWN_MAX_ATTEMPTS = 3
  const GIT_SPAWN_RETRY_BASE_MS = 25
  const TRANSIENT_GIT_SPAWN_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"])

  export function environment(overrides?: Record<string, string>) {
    const env = Object.fromEntries(
      Object.entries(RuntimeContext.current().host.env).filter(([key]) => !key.startsWith("GIT_")),
    )
    return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", ...overrides }
  }

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

  function abortedGitResult(): { exitCode: number; text: string; bytes: Uint8Array; stderr: string } {
    return { exitCode: -1, text: "", bytes: new Uint8Array(), stderr: "" }
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

  function gitSpawnError(error: unknown) {
    const code = (error as { code?: unknown })?.code
    const message = error instanceof Error ? error.message : String(error)
    return {
      code: typeof code === "string" ? code : undefined,
      message,
    }
  }

  function isTransientGitSpawnError(error: unknown) {
    const code = gitSpawnError(error).code
    return code !== undefined && TRANSIENT_GIT_SPAWN_CODES.has(code)
  }

  async function waitForGitSpawnRetry(attempt: number, signal?: AbortSignal) {
    if (signal?.aborted) return false
    const delayMs = GIT_SPAWN_RETRY_BASE_MS * 2 ** (attempt - 1)
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        resolve(value)
      }
      const onAbort = () => finish(false)
      timer = setTimeout(() => finish(true), delayMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  export async function run(
    args: string[],
    cwd: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<{ exitCode: number; text: string; bytes: Uint8Array; stderr: string }> {
    if (signal?.aborted) return abortedGitResult()
    for (let attempt = 1; ; attempt++) {
      const childSignal = spawnSignal(SNAPSHOT_TIMEOUT_MS, signal)
      let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> | undefined
      let location: Awaited<ReturnType<typeof SnapshotPath.repository>> | undefined
      try {
        location = await SnapshotPath.repository(args)
        proc = Bun.spawn(command(location.args), {
          cwd: startupDirectory(cwd, args),
          stdin: stdin === undefined ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: environment(env),
          signal: childSignal.signal,
        })
        if (stdin !== undefined) {
          if (!proc.stdin) throw new Error("git subprocess stdin pipe unavailable")
          proc.stdin.write(stdin)
          proc.stdin.end()
        }
        const stdout = new Response(proc.stdout).bytes()
        const stderr = new Response(proc.stderr).text().catch(() => "")
        const [bytes, stderrText, exitCode] = await withTimeout(
          withAbort(Promise.all([stdout, stderr, proc.exited]), childSignal.signal),
          SNAPSHOT_HARD_TIMEOUT_MS,
          { message: `git subprocess did not settle within ${SNAPSHOT_HARD_TIMEOUT_MS}ms` },
        )
        return {
          exitCode,
          text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
          bytes,
          stderr: stderrText,
        }
      } catch (error) {
        if (signal?.aborted) {
          try {
            proc?.kill()
          } catch {}
          return abortedGitResult()
        }
        try {
          proc?.kill()
        } catch {}
        const details = gitSpawnError(error)
        const retrying = proc === undefined && isTransientGitSpawnError(error) && attempt < GIT_SPAWN_MAX_ATTEMPTS
        log.warn("git spawn failed", {
          args,
          cwd,
          attempt,
          maxAttempts: GIT_SPAWN_MAX_ATTEMPTS,
          retrying,
          code: details.code,
          error: details.message,
        })
        if (!retrying || !(await waitForGitSpawnRetry(attempt, signal))) {
          const stderr = details.code ? `${details.code}: ${details.message}` : details.message
          return { exitCode: -1, text: "", bytes: new Uint8Array(), stderr }
        }
      } finally {
        if (proc?.exitCode === null) proc.kill()
        await proc?.exited.catch(() => {})
        await location?.[Symbol.asyncDispose]()
        childSignal.cleanup()
      }
    }
  }
}
