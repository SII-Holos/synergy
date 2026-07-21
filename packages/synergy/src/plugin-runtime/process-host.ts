import fs from "fs"
import { fileURLToPath } from "url"
import type { PluginLogEntry } from "./logs.js"
import {
  deserializePluginRuntimeError,
  serializePluginRuntimeError,
  type HostToPlugin,
  type PluginToHost,
  type RuntimeActivationData,
} from "./protocol.js"

const runnerPath = fileURLToPath(new URL("./runner.ts", import.meta.url))

export interface PluginProcessHost {
  process: Bun.Subprocess
  send(message: HostToPlugin): void
  request(message: Extract<HostToPlugin, { type: "invoke" }>): Promise<{ generation: string; value: unknown }>
  /** Settle a pending invoke as failed. Idempotent; late responses are ignored after this. */
  rejectRequest(requestId: string, error: Error): boolean
  stop(graceMs: number): Promise<void>
}

export interface SpawnPluginProcessOptions {
  entryPath: string
  pluginDir: string
  activation: RuntimeActivationData
  onReady(message: Extract<PluginToHost, { type: "ready" }>): void
  onHostRequest(message: Extract<PluginToHost, { type: "hostRequest" }>): Promise<unknown>
  onHeartbeat(): void
  onLog(entry: PluginLogEntry): void
  onExit(exitCode: number | null, signal: string | null): void
}

type PendingRequest = {
  settle(result: { ok: true; value: { generation: string; value: unknown } } | { ok: false; error: Error }): boolean
}

/** Single-settle pending IPC invokes. Exported for unit tests. */
export function createPendingRequestMap() {
  const pending = new Map<string, PendingRequest>()

  function settle(
    requestId: string,
    result: { ok: true; value: { generation: string; value: unknown } } | { ok: false; error: Error },
  ) {
    const request = pending.get(requestId)
    if (!request) return false
    pending.delete(requestId)
    return request.settle(result)
  }

  return {
    size() {
      return pending.size
    },
    track(requestId: string) {
      return new Promise<{ generation: string; value: unknown }>((resolve, reject) => {
        let settled = false
        pending.set(requestId, {
          settle(result) {
            if (settled) return false
            settled = true
            if (result.ok) resolve(result.value)
            else reject(result.error)
            return true
          },
        })
      })
    },
    resolve(requestId: string, value: { generation: string; value: unknown }) {
      return settle(requestId, { ok: true, value })
    },
    reject(requestId: string, error: Error) {
      return settle(requestId, { ok: false, error })
    },
    rejectAll(error: Error) {
      const ids = [...pending.keys()]
      for (const requestId of ids) settle(requestId, { ok: false, error })
    },
  }
}

export function resolvePluginProcessRunnerCommand(entryPath: string): string[] {
  if (fs.existsSync(runnerPath)) return [process.execPath, "run", runnerPath, entryPath]
  return [process.execPath, "__plugin-runtime-runner", entryPath]
}

export function spawnPluginProcess(options: SpawnPluginProcessOptions): PluginProcessHost {
  const pending = createPendingRequestMap()
  const processHandle = Bun.spawn({
    cmd: resolvePluginProcessRunnerCommand(options.entryPath),
    cwd: options.pluginDir,
    ipc(message) {
      const parsed = (typeof message === "string" ? JSON.parse(message) : message) as PluginToHost
      if (parsed.type === "ready") options.onReady(parsed)
      else if (parsed.type === "heartbeat") options.onHeartbeat()
      else if (parsed.type === "log") {
        options.onLog({ timestamp: Date.now(), level: parsed.level, message: parsed.message })
      } else if (parsed.type === "response") {
        if (parsed.ok) pending.resolve(parsed.requestId, { generation: parsed.generation, value: parsed.value })
        else pending.reject(parsed.requestId, deserializePluginRuntimeError(parsed.error))
      } else if (parsed.type === "hostRequest") {
        void options.onHostRequest(parsed).then(
          (value) => send({ type: "hostResponse", requestId: parsed.requestId, ok: true, value }),
          (error) =>
            send({
              type: "hostResponse",
              requestId: parsed.requestId,
              ok: false,
              error: serializePluginRuntimeError(error),
            }),
        )
      }
    },
    stdout: "ignore",
    stderr: "ignore",
    onExit(_process, exitCode, signalCode) {
      const error = new Error(`Plugin runtime exited (${exitCode ?? signalCode ?? "unknown"})`)
      pending.rejectAll(error)
      options.onExit(exitCode, signalCode?.toString() ?? null)
    },
  })

  function send(message: HostToPlugin) {
    processHandle.send(message)
  }

  send({ type: "activate", input: options.activation })
  return {
    process: processHandle,
    send,
    request(message) {
      const tracked = pending.track(message.requestId)
      send(message)
      return tracked
    },
    rejectRequest(requestId, error) {
      return pending.reject(requestId, error)
    },
    async stop(graceMs) {
      if (processHandle.exitCode !== null) return
      try {
        send({ type: "shutdown" })
      } catch {
        return
      }
      const exited = await Promise.race([
        processHandle.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ])
      if (!exited) processHandle.kill()
    },
  }
}
