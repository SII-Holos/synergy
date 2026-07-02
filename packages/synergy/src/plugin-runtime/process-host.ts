import type {
  PluginToHost,
  HostToPlugin,
  IsolatedPluginInputData,
  RuntimeToolDescriptor,
  HostBridgeHandler,
} from "./protocol.js"
import { MESSAGE_DELIMITER } from "./protocol.js"
import { deserializeError, classifyRuntimeExit } from "./errors.js"
import type { RuntimeExit, PluginRuntimeError } from "./errors.js"
import type { PluginLogEntry } from "./logs.js"
import type { ConcurrencyLimiter } from "./resource-limits.js"
import { fileURLToPath } from "url"
import fs from "fs"

const RUNNER_PATH = fileURLToPath(new URL("./runner.ts", import.meta.url))

// ── Plugin process state ─────────────────────────────────────────

interface PluginState {
  ready: boolean
  tools: RuntimeToolDescriptor[]
  hooks: string[]
  lastHeartbeat: number
  exitCode: number | null
  signalCode: string | null
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export function resolvePluginProcessRunnerCommand(
  entryPath: string,
  runnerExists = fs.existsSync(RUNNER_PATH),
): string[] {
  if (runnerExists) return [process.execPath, "run", RUNNER_PATH, entryPath]
  return [process.execPath, "__plugin-runtime-runner", entryPath]
}

async function captureProcessLogs(
  stream: ReadableStream<Uint8Array> | null,
  level: string,
  onLog?: (entry: PluginLogEntry) => void,
) {
  if (!stream || !onLog) return
  const decoder = new TextDecoder()
  let buffered = ""
  const reader = stream.getReader()
  while (true) {
    const { value: chunk, done } = await reader.read()
    if (done) break
    if (!chunk) continue
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim()) onLog({ timestamp: Date.now(), level, message: line })
    }
  }
  buffered += decoder.decode()
  if (buffered.trim()) onLog({ timestamp: Date.now(), level, message: buffered })
}

// ── Message handler type ─────────────────────────────────────────

type MessageHandler = (msg: PluginToHost) => void

// ── spawnPluginProcess ────────────────────────────────────────────

export interface SpawnPluginProcessOptions {
  pluginId: string
  pluginDir: string
  entryPath: string
  input: IsolatedPluginInputData
  hostBridgeHandler?: HostBridgeHandler
  concurrencyLimiter?: ConcurrencyLimiter
  onHeartbeat?: () => void
  onReady?: () => void
  onLog?: (entry: PluginLogEntry) => void
  onError?: (error: PluginRuntimeError) => void
  onExit?: (exit: RuntimeExit) => void
}

export async function spawnPluginProcess(options: SpawnPluginProcessOptions): Promise<{
  process: Bun.Subprocess
  onMessage: (handler: MessageHandler) => void
  send: (msg: HostToPlugin) => void
  kill: () => void
}> {
  const { pluginId, pluginDir, entryPath, input, hostBridgeHandler, concurrencyLimiter } = options
  const { onHeartbeat, onReady, onLog, onError, onExit } = options

  const pluginState: PluginState = {
    ready: false,
    tools: [],
    hooks: [],
    lastHeartbeat: 0,
    exitCode: null,
    signalCode: null,
  }

  const pendingRequests = new Map<string, PendingRequest>()
  let messageHandler: MessageHandler | null = null

  // ── Message routing ──────────────────────────────────────────

  function routeMessage(msg: PluginToHost): void {
    switch (msg.type) {
      case "ready": {
        pluginState.ready = true
        pluginState.tools = msg.tools
        pluginState.hooks = msg.hooks
        onReady?.()
        break
      }
      case "response": {
        const pending = pendingRequests.get(msg.requestId)
        if (pending) {
          pendingRequests.delete(msg.requestId)
          if (msg.ok) {
            pending.resolve(msg.value)
          } else {
            const err = deserializeError(msg.error)
            pending.reject(err)
          }
        }
        break
      }
      case "hostRequest": {
        if (concurrencyLimiter && !concurrencyLimiter.acquire()) {
          proc.send(
            JSON.stringify({
              type: "bridgeResponse",
              requestId: msg.requestId,
              ok: false,
              error: {
                name: "Error",
                message: `Concurrency limit exceeded for plugin "${pluginId}"`,
              },
            } satisfies HostToPlugin) + MESSAGE_DELIMITER,
          )
          break
        }
        const onComplete = () => concurrencyLimiter?.release()
        if (hostBridgeHandler) {
          hostBridgeHandler(msg.requestId, msg.method, msg.params)
            .then((value) => {
              onComplete()
              proc.send(
                JSON.stringify({
                  type: "bridgeResponse",
                  requestId: msg.requestId,
                  ok: true,
                  value,
                } satisfies HostToPlugin) + MESSAGE_DELIMITER,
              )
            })
            .catch((err: Error) => {
              onComplete()
              proc.send(
                JSON.stringify({
                  type: "bridgeResponse",
                  requestId: msg.requestId,
                  ok: false,
                  error: {
                    name: err.name,
                    message: err.message,
                    stack: err.stack,
                  },
                } satisfies HostToPlugin) + MESSAGE_DELIMITER,
              )
            })
        } else {
          onComplete()
          // No bridge handler registered — reject with an error
          proc.send(
            JSON.stringify({
              type: "bridgeResponse",
              requestId: msg.requestId,
              ok: false,
              error: {
                name: "Error",
                message: `No host bridge handler registered for plugin "${pluginId}"`,
              },
            } satisfies HostToPlugin) + MESSAGE_DELIMITER,
          )
        }
        break
      }
      case "log": {
        onLog?.({ timestamp: Date.now(), level: msg.level, message: msg.message })
        break
      }
      case "heartbeat": {
        pluginState.lastHeartbeat = Date.now()
        onHeartbeat?.()
        break
      }
    }

    // Forward to the registered handler
    messageHandler?.(msg)
  }

  // ── Spawn subprocess ─────────────────────────────────────────

  const proc = Bun.spawn({
    cmd: resolvePluginProcessRunnerCommand(entryPath),
    cwd: pluginDir,
    ipc: (message: string) => {
      try {
        const msg = JSON.parse(message) as PluginToHost
        routeMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    },
    stdout: "pipe",
    stderr: "pipe",
    onExit: (_proc, exitCode, signalCode, _error) => {
      pluginState.exitCode = exitCode
      pluginState.signalCode = signalCode?.toString() ?? null
      onExit?.({
        exitCode,
        signalCode: signalCode?.toString() ?? null,
        classification: classifyRuntimeExit(exitCode, signalCode?.toString() ?? null),
      })
    },
  })
  void captureProcessLogs(proc.stdout, "info", onLog).catch(() => {})
  void captureProcessLogs(proc.stderr, "error", onLog).catch(() => {})

  // ── Send init message ────────────────────────────────────────

  proc.send(
    JSON.stringify({
      type: "init",
      pluginId,
      input,
    } satisfies HostToPlugin) + MESSAGE_DELIMITER,
  )

  return {
    process: proc,
    onMessage: (handler: MessageHandler) => {
      messageHandler = handler
    },
    send: (msg: HostToPlugin) => {
      proc.send(JSON.stringify(msg) + MESSAGE_DELIMITER)
    },
    kill: () => {
      proc.kill()
    },
  }
}
