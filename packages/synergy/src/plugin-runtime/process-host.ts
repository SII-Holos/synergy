import fs from "fs"
import { fileURLToPath } from "url"
import type { PluginLogEntry } from "./logs.js"
import type { HostToPlugin, PluginToHost, RuntimeActivationData, SerializedPluginRuntimeError } from "./protocol.js"

const runnerPath = fileURLToPath(new URL("./runner.ts", import.meta.url))

export interface PluginProcessHost {
  process: Bun.Subprocess
  send(message: HostToPlugin): void
  request(message: Extract<HostToPlugin, { type: "invoke" }>): Promise<{ generation: string; value: unknown }>
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

function runtimeError(error: SerializedPluginRuntimeError) {
  return Object.assign(new Error(error.message), { name: error.name, stack: error.stack, code: error.code })
}

export function resolvePluginProcessRunnerCommand(entryPath: string): string[] {
  if (fs.existsSync(runnerPath)) return [process.execPath, "run", runnerPath, entryPath]
  return [process.execPath, "__plugin-runtime-runner", entryPath]
}

export function spawnPluginProcess(options: SpawnPluginProcessOptions): PluginProcessHost {
  const pending = new Map<
    string,
    { resolve(value: { generation: string; value: unknown }): void; reject(error: Error): void }
  >()
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
        const request = pending.get(parsed.requestId)
        if (!request) return
        pending.delete(parsed.requestId)
        if (parsed.ok) request.resolve({ generation: parsed.generation, value: parsed.value })
        else request.reject(runtimeError(parsed.error))
      } else if (parsed.type === "hostRequest") {
        void options.onHostRequest(parsed).then(
          (value) => send({ type: "hostResponse", requestId: parsed.requestId, ok: true, value }),
          (error) =>
            send({
              type: "hostResponse",
              requestId: parsed.requestId,
              ok: false,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              },
            }),
        )
      }
    },
    stdout: "ignore",
    stderr: "ignore",
    onExit(_process, exitCode, signalCode) {
      const error = new Error(`Plugin runtime exited (${exitCode ?? signalCode ?? "unknown"})`)
      for (const request of pending.values()) request.reject(error)
      pending.clear()
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
      return new Promise((resolve, reject) => {
        pending.set(message.requestId, { resolve, reject })
        send(message)
      })
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
