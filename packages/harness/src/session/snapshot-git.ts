import { Log } from "../util/log"
import { withTimeout } from "../util/timeout"
import path from "node:path"

export namespace SnapshotGit {
  export async function* lines(repo: string, args: string[], options: { signal?: AbortSignal; input?: string } = {}) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
      : AbortSignal.timeout(30 * 60_000)
    signal.throwIfAborted()
    const proc = Bun.spawn(["git", "--git-dir", repo, ...args], {
      cwd: path.dirname(repo),
      env: environment(),
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.input ? Bun.file(options.input) : "ignore",
      signal,
    })
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
    const pack = Bun.spawn(["git", "--git-dir", source, "pack-objects", "--stdout"], {
      cwd: path.dirname(source),
      env: environment(),
      stdin: Bun.file(inventory),
      stdout: "pipe",
      stderr: "pipe",
      signal: abort,
    })
    const packErrors = tail(pack.stderr)
    let imported: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
    try {
      imported = Bun.spawn(["git", "--git-dir", target, "index-pack", "--stdin", "--strict", `--keep=${keepToken}`], {
        cwd: path.dirname(target),
        env: environment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: abort,
      })
      const sink = imported.stdin
      const transport = (async () => {
        const reader = pack.stdout.getReader()
        try {
          for (;;) {
            const chunk = await withAbort(reader.read(), abort)
            if (chunk.done) break
            sink.write(chunk.value)
            await sink.flush()
          }
          await sink.end()
        } finally {
          reader.releaseLock()
        }
      })()
      const outputs = await withAbort(
        Promise.all([
          pack.exited,
          imported.exited,
          packErrors,
          tail(imported.stderr),
          tail(imported.stdout),
          transport,
        ]),
        abort,
      )
      if (outputs[0] !== 0 || outputs[1] !== 0)
        throw new Error(`Snapshot pack transfer failed: ${outputs[2]} ${outputs[3]}`)
      const hash = outputs[4].trim().split(/\s+/).at(-1)
      if (!hash || !/^[0-9a-f]{40}$/.test(hash)) throw new Error("Snapshot pack import did not report an object ID")
      return hash
    } finally {
      if (pack.exitCode === null) pack.kill()
      if (imported?.exitCode === null) imported.kill()
      await Promise.allSettled([pack.exited, imported?.exited, packErrors])
    }
  }

  const log = Log.create({ service: "snapshot" })
  const SNAPSHOT_TIMEOUT_MS = 10_000
  const SNAPSHOT_HARD_TIMEOUT_MS = SNAPSHOT_TIMEOUT_MS + 5_000
  const GIT_SPAWN_MAX_ATTEMPTS = 3
  const GIT_SPAWN_RETRY_BASE_MS = 25
  const TRANSIENT_GIT_SPAWN_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE", "ENOMEM"])

  export function environment(overrides?: Record<string, string>) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
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
  ): Promise<{ exitCode: number; text: string; stderr: string }> {
    if (signal?.aborted) return abortedGitResult()
    for (let attempt = 1; ; attempt++) {
      const childSignal = spawnSignal(SNAPSHOT_TIMEOUT_MS, signal)
      let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe"> | undefined
      try {
        proc = Bun.spawn(args, {
          cwd,
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
        const stdout = new Response(proc.stdout).text()
        const stderr = new Response(proc.stderr).text().catch(() => "")
        const [text, stderrText, exitCode] = await withTimeout(
          withAbort(Promise.all([stdout, stderr, proc.exited]), childSignal.signal),
          SNAPSHOT_HARD_TIMEOUT_MS,
          { message: `git subprocess did not settle within ${SNAPSHOT_HARD_TIMEOUT_MS}ms` },
        )
        return { exitCode, text, stderr: stderrText }
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
          return { exitCode: -1, text: "", stderr }
        }
      } finally {
        childSignal.cleanup()
      }
    }
  }
}
