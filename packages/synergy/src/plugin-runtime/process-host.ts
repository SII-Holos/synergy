import type {
  PluginToHost,
  HostToPlugin,
  IsolatedPluginInputData,
  RuntimeToolDescriptor,
  HostBridgeMethod,
} from "./protocol.js"
import { MESSAGE_DELIMITER } from "./protocol.js"
import { getRuntime } from "./supervisor.js"

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

// ── Message handler type ─────────────────────────────────────────

type MessageHandler = (msg: PluginToHost) => void

// ── Host bridge handler type ─────────────────────────────────────

export type HostBridgeHandler = (requestId: string, method: HostBridgeMethod, params: unknown) => Promise<unknown>

// ── Helpers ──────────────────────────────────────────────────────

function reconstructError(serialized: { name: string; message: string; stack?: string }): Error {
  const err = new Error(serialized.message)
  err.name = serialized.name
  if (serialized.stack) err.stack = serialized.stack
  return err
}

// ── spawnPluginProcess ────────────────────────────────────────────

export async function spawnPluginProcess(options: {
  pluginId: string
  pluginDir: string
  entryPath: string
  input: IsolatedPluginInputData
  hostBridgeHandler?: HostBridgeHandler
}): Promise<{
  process: Bun.Subprocess
  onMessage: (handler: MessageHandler) => void
  send: (msg: HostToPlugin) => void
  kill: () => void
  state: PluginState
}> {
  const { pluginId, pluginDir, entryPath, input, hostBridgeHandler } = options

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
        break
      }
      case "response": {
        const pending = pendingRequests.get(msg.requestId)
        if (pending) {
          pendingRequests.delete(msg.requestId)
          if (msg.ok) {
            pending.resolve(msg.value)
          } else {
            const cause = msg.error.cause ? reconstructError(msg.error.cause) : undefined
            const err = reconstructError(msg.error)
            if (cause) err.cause = cause
            pending.reject(err)
          }
        }
        break
      }
      case "hostRequest": {
        const runtimeEntry = getRuntime(pluginId)
        if (runtimeEntry?.concurrencyLimiter && !runtimeEntry.concurrencyLimiter.acquire()) {
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
        const onComplete = () => runtimeEntry?.concurrencyLimiter?.release()
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
        const entry = getRuntime(pluginId)
        if (entry?.logRateLimiter && !entry.logRateLimiter.allow(msg.message.length)) return
        break
      }
      case "heartbeat": {
        pluginState.lastHeartbeat = Date.now()
        const entry = getRuntime(pluginId)
        if (entry) entry.lastHeartbeatAt = Date.now()
        break
      }
    }

    // Forward to the registered handler
    messageHandler?.(msg)
  }

  // ── Spawn subprocess ─────────────────────────────────────────

  const proc = Bun.spawn({
    cmd: ["bun", "run", entryPath],
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
    },
  })

  // ── Send init message ────────────────────────────────────────

  proc.send(
    JSON.stringify({
      type: "init",
      pluginId,
      input,
    } satisfies HostToPlugin) + MESSAGE_DELIMITER,
  )

  return {
    // Bun.spawn with ipc + no stdin infers Subprocess<"ignore", "pipe", "pipe">
    // which is assignable to Bun.Subprocess (default type params).
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
    state: pluginState,
  }
}
