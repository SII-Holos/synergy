import { Worker } from "node:worker_threads"
import { fileURLToPath } from "url"
import type {
  PluginToHost,
  HostToPlugin,
  IsolatedPluginInputData,
  RuntimeToolDescriptor,
  HostBridgeHandler,
} from "./protocol.js"
import type { PluginLogEntry } from "./logs.js"
import type { RuntimeExit } from "./errors.js"
import { classifyRuntimeExit, PluginRuntimeError } from "./errors.js"
import type { ConcurrencyLimiter } from "./resource-limits.js"

const RUNNER_PATH = fileURLToPath(new URL("./runner.ts", import.meta.url))

type WorkerFactory = (
  filename: string,
  options: { workerData: { entryPath: string; input: IsolatedPluginInputData } },
) => Worker

const defaultWorkerFactory: WorkerFactory = (filename, options) => new Worker(filename, options)
let workerFactory = defaultWorkerFactory

export function setWorkerFactoryForTest(factory?: WorkerFactory): void {
  workerFactory = factory ?? defaultWorkerFactory
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

export interface WorkerState {
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

export interface SpawnPluginWorkerOptions {
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

export async function spawnPluginWorker(options: SpawnPluginWorkerOptions): Promise<SpawnedWorkerRuntime> {
  const { pluginId, pluginDir, entryPath, input, hostBridgeHandler } = options
  const { concurrencyLimiter } = options
  const { onHeartbeat, onReady, onLog, onError, onExit } = options

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
        onReady?.()
        break
      }
      case "hostRequest": {
        if (concurrencyLimiter && !concurrencyLimiter.acquire()) {
          worker.postMessage({
            type: "bridgeResponse",
            requestId: msg.requestId,
            ok: false,
            error: {
              name: "Error",
              message: `Concurrency limit exceeded for plugin "${pluginId}"`,
            },
          } satisfies HostToPlugin)
          break
        }
        const onComplete = () => concurrencyLimiter?.release()
        if (hostBridgeHandler) {
          hostBridgeHandler(msg.requestId, msg.method, msg.params)
            .then((value) => {
              onComplete()
              worker.postMessage({
                type: "bridgeResponse",
                requestId: msg.requestId,
                ok: true,
                value,
              } satisfies HostToPlugin)
            })
            .catch((err: Error) => {
              onComplete()
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
          onComplete()
          worker.postMessage({
            type: "bridgeResponse",
            requestId: msg.requestId,
            ok: false,
            error: {
              name: "Error",
              message: `No host bridge handler registered for plugin "${pluginId}"`,
            },
          } satisfies HostToPlugin)
        }
        break
      }
      case "log": {
        onLog?.({ timestamp: Date.now(), level: msg.level, message: msg.message })
        break
      }
      case "heartbeat": {
        workerState.lastHeartbeat = Date.now()
        onHeartbeat?.()
        break
      }
    }

    // Forward all messages to the registered handler
    messageHandler?.(msg)
  }

  // ── Spawn worker ────────────────────────────────────

  const worker = workerFactory(RUNNER_PATH, {
    workerData: { entryPath, input },
  })

  worker.on("message", (msg: unknown) => {
    // Workers use structured clone; validate the message
    if (msg && typeof msg === "object") {
      routeMessage(msg as PluginToHost)
    }
  })

  worker.on("error", (err: Error) => {
    onError?.(new PluginRuntimeError(pluginId, "worker_error", err.message, { cause: err }))
  })

  worker.on("exit", (code: number) => {
    workerState.exitCode = code
    onExit?.({
      exitCode: code,
      signalCode: null,
      classification: classifyRuntimeExit(code, null),
    })
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
