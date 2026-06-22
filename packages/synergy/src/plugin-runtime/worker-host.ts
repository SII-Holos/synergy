import { Log } from "../util/log"
import { pushWarning } from "./runtime-registry.js"
import { Worker } from "node:worker_threads"
import type {
  PluginToHost,
  HostToPlugin,
  IsolatedPluginInputData,
  RuntimeToolDescriptor,
  HostBridgeHandler,
} from "./protocol.js"
import type { PluginLogBuffer } from "./logs.js"

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

interface WorkerState {
  ready: boolean
  tools: RuntimeToolDescriptor[]
  hooks: string[]
  lastHeartbeat: number
  exitCode: number | null
  signalCode: string | null
}

type MessageHandler = (msg: PluginToHost) => void

export interface SpawnedWorkerRuntime {
  worker: Worker
  onMessage: (handler: MessageHandler) => void
  send: (msg: HostToPlugin) => void
  kill: () => void
  state: WorkerState
}

// ---------------------------------------------------------------------------
// spawnPluginWorker
// ---------------------------------------------------------------------------

export async function spawnPluginWorker(options: {
  pluginId: string
  pluginDir: string
  entryPath: string
  input: IsolatedPluginInputData
  hostBridgeHandler?: HostBridgeHandler
  logBuffer?: PluginLogBuffer
}): Promise<SpawnedWorkerRuntime> {
  const { entryPath, input, hostBridgeHandler, logBuffer } = options

  const workerState: WorkerState = {
    ready: false,
    tools: [],
    hooks: [],
    lastHeartbeat: 0,
    exitCode: null,
    signalCode: null,
  }

  let messageHandler: MessageHandler | null = null

  // ── Message routing ──────────────────────────────────

  function routeMessage(msg: PluginToHost): void {
    switch (msg.type) {
      case "ready": {
        workerState.ready = true
        workerState.tools = msg.tools ?? []
        workerState.hooks = msg.hooks ?? []
        break
      }
      case "hostRequest": {
        if (hostBridgeHandler) {
          hostBridgeHandler(msg.requestId, msg.method, msg.params)
            .then((value) => {
              worker.postMessage({
                type: "bridgeResponse",
                requestId: msg.requestId,
                ok: true,
                value,
              } satisfies HostToPlugin)
            })
            .catch((err: Error) => {
              worker.postMessage({
                type: "bridgeResponse",
                requestId: msg.requestId,
                ok: false,
                error: {
                  name: err.name,
                  message: err.message,
                  stack: err.stack,
                },
              } satisfies HostToPlugin)
            })
        } else {
          worker.postMessage({
            type: "bridgeResponse",
            requestId: msg.requestId,
            ok: false,
            error: {
              name: "Error",
              message: `No host bridge handler registered for plugin "${options.pluginId}"`,
            },
          } satisfies HostToPlugin)
        }
        break
      }
      case "log": {
        logBuffer?.append(options.pluginId, { timestamp: Date.now(), level: msg.level, message: msg.message })
        break
      }
      case "heartbeat": {
        workerState.lastHeartbeat = Date.now()
        break
      }
    }

    // Forward all messages to the registered handler
    messageHandler?.(msg)
  }

  // ── Spawn worker ────────────────────────────────────

  const worker = new Worker(entryPath, {
    workerData: input,
  })

  worker.on("message", (msg: unknown) => {
    // Workers use structured clone; validate the message
    if (msg && typeof msg === "object") {
      routeMessage(msg as PluginToHost)
    }
  })

  worker.on("error", (err: Error) => {
    Log.Default.error("plugin worker error", { pluginId: options.pluginId, error: err.message })
    pushWarning(options.pluginId, "worker_error", err.message)
  })

  worker.on("exit", (code: number) => {
    workerState.exitCode = code
  })

  return {
    worker,
    onMessage: (handler: MessageHandler) => {
      messageHandler = handler
    },
    send: (msg: HostToPlugin) => {
      worker.postMessage(msg)
    },
    kill: () => {
      try {
        worker.terminate()
      } catch {
        // Worker may already be dead
      }
    },
    state: workerState,
  }
}
