import {
  installedWorkerCommand,
  InstallationPin,
  InstalledWorkerReady,
  INSTALLED_WORKER_CONTROL_VERSION,
} from "@ericsanchezok/synergy-util/installed-launcher"
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
  onStart?(phase: "bootstrap" | "activation"): boolean | void
  onError?(error: Error): void
  onReady(message: Extract<PluginToHost, { type: "ready" }>): void
  onHostRequest(message: Extract<PluginToHost, { type: "hostRequest" }>): Promise<unknown>
  onHeartbeat(message: Extract<PluginToHost, { type: "heartbeat" }>): void
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

export function resolvePluginProcessRunnerCommand(entryPath: string, env = process.env): string[] {
  const installed = installedWorkerCommand(env, "__plugin-runtime-runner", [entryPath])
  if (installed) return installed
  if (fs.existsSync(runnerPath)) return [process.execPath, "run", runnerPath, entryPath]
  return [process.execPath, "__plugin-runtime-runner", entryPath]
}

export function spawnPluginProcess(options: SpawnPluginProcessOptions): PluginProcessHost {
  const pending = createPendingRequestMap()
  const env = { ...process.env }
  const command = resolvePluginProcessRunnerCommand(options.entryPath, env)
  const bootstrapPin =
    env.SYNERGY_INSTALLATION_PIN && env.SYNERGY_LAUNCHER_CONTROL_VERSION === String(INSTALLED_WORKER_CONTROL_VERSION)
      ? InstallationPin.parse(JSON.parse(env.SYNERGY_INSTALLATION_PIN))
      : undefined
  env.SYNERGY_WORKER_CONTROL_VERSION = bootstrapPin ? String(INSTALLED_WORKER_CONTROL_VERSION) : undefined
  let activated = false
  let closed = false
  let stopping: Promise<void> | undefined
  if (options.onStart?.(bootstrapPin ? "bootstrap" : "activation") === false)
    throw new Error("Plugin runtime stopped before spawn")
  const processHandle = Bun.spawn({
    cmd: command,
    cwd: options.pluginDir,
    env,
    ipc(message) {
      if (closed) return
      let value: unknown
      try {
        value = typeof message === "string" ? JSON.parse(message) : message
      } catch {
        fail(new Error("Malformed plugin launcher message"))
        return
      }
      if (value && typeof value === "object" && "synergyLauncher" in value) {
        const frame = InstalledWorkerReady.safeParse(value)
        if (
          !bootstrapPin ||
          !frame.success ||
          frame.data.pin.id !== bootstrapPin.id ||
          frame.data.pin.sha256 !== bootstrapPin.sha256
        ) {
          fail(new Error("Invalid plugin launcher bootstrap frame"))
          return
        }
        if (activated) return
        if (options.onStart?.("activation") === false) return
        activated = true
        if (!send({ type: "activate", input: options.activation }))
          fail(new Error("Plugin runtime connection is closed"))
        return
      }
      if (!value || typeof value !== "object" || !("type" in value)) {
        fail(new Error("Malformed plugin launcher message"))
        return
      }
      const parsed = value as PluginToHost
      if (parsed.type === "ready") {
        if (!activated) fail(new Error("Plugin runtime ready before activation"))
        else options.onReady(parsed)
      } else if (parsed.type === "heartbeat") options.onHeartbeat(parsed)
      else if (parsed.type === "log") {
        options.onLog({
          timestamp: Date.now(),
          level: parsed.level,
          message: parsed.message,
          details: parsed.details,
        })
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
      closed = true
      const error = new Error(`Plugin runtime exited (${exitCode ?? signalCode ?? "unknown"})`)
      pending.rejectAll(error)
      options.onExit(exitCode, signalCode?.toString() ?? null)
    },
  })

  function send(message: HostToPlugin) {
    if (processHandle.exitCode !== null || (closed && message.type !== "shutdown")) return false
    try {
      processHandle.send(message)
      return true
    } catch (error) {
      pending.rejectAll(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  function fail(error: Error) {
    if (closed) return
    closed = true
    pending.rejectAll(error)
    if (options.onError) options.onError(error)
    else processHandle.kill("SIGKILL")
  }

  if (!bootstrapPin) {
    activated = true
    if (!send({ type: "activate", input: options.activation })) fail(new Error("Plugin runtime connection is closed"))
  }
  return {
    process: processHandle,
    send,
    request(message) {
      const tracked = pending.track(message.requestId)
      if (!send(message)) pending.reject(message.requestId, new Error("Plugin runtime connection is closed"))
      return tracked
    },
    rejectRequest(requestId, error) {
      return pending.reject(requestId, error)
    },
    async stop(graceMs) {
      if (stopping) return stopping
      closed = true
      pending.rejectAll(new Error("Plugin runtime stopped"))
      stopping = (async () => {
        if (processHandle.exitCode === null) {
          send({ type: "shutdown" })
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            const exited = await Promise.race([
              processHandle.exited.then(() => true),
              new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), graceMs)
              }),
            ])
            if (!exited) processHandle.kill("SIGKILL")
          } finally {
            clearTimeout(timeout)
          }
        }
        await processHandle.exited
      })()
      return stopping
    },
  }
}
