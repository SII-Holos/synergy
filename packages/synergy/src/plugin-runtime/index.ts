// ---------------------------------------------------------------------------
// plugin-runtime — public API
// ---------------------------------------------------------------------------

// Protocol
export type {
  HostToPlugin,
  PluginToHost,
  HostBridgeMethod,
  IsolatedPluginInputData,
  RuntimeToolDescriptor,
  SerializedError,
} from "./protocol.js"
export type { HostBridgeHandler } from "./protocol.js"
export { MESSAGE_DELIMITER } from "./protocol.js"

// Supervisor
export type { RuntimeMode, RuntimeState, RuntimeEntry } from "./supervisor.js"
export {
  getRuntime,
  getAllRuntimes,
  getRuntimeState,
  getLogBuffer,
  startRuntime,
  stopRuntime,
  reloadRuntime,
  killRuntime,
  restoreRuntimeState,
} from "./supervisor.js"

export { spawnPluginProcess } from "./process-host.js"

export type { SpawnedWorkerRuntime } from "./worker-host.js"
export { spawnPluginWorker } from "./worker-host.js"

// Bridge client (plugin-side)
export type { ConfigBridge, SecretBridge, CacheBridge, HostBridge } from "./bridge.js"
export { REQUEST_TIMEOUT_MS, createBridgeClient } from "./bridge.js"

// Health
export { DEFAULT_LIMITS, startHeartbeatMonitor } from "./health.js"

// Resource limits
export { ConcurrencyLimiter, getProcessMemoryMb, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"

// Bridge enforcement (host-side)
export { BRIDGE_METHOD_CAPABILITY, createBridgeEnforcementHandler } from "./bridge-enforcement.js"
export type { BridgeEnforcementResult } from "./bridge-enforcement.js"

// Log buffer
export { PluginLogBuffer } from "./logs.js"
export type { PluginLogEntry } from "./logs.js"
