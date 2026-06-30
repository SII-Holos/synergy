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
  HostBridgeHandler,
} from "./protocol.js"
export { MESSAGE_DELIMITER } from "./protocol.js"

// Supervisor
export type { RuntimeMode, RuntimeState, RuntimeEntry } from "./supervisor.js"
export {
  getRuntime,
  getAllRuntimes,
  getRuntimeState,
  getRuntimeHealth,
  getLogBuffer,
  startRuntime,
  stopRuntime,
  reloadRuntime,
  killRuntime,
  invokeRuntimeTool,
  triggerRuntimeHook,
  restoreRuntimeState,
} from "./supervisor.js"

// Registry
export { RuntimeRegistry, defaultRuntimeRegistry, type PersistedRuntimeEntry, type RuntimeHealth } from "./registry.js"

export { spawnPluginProcess } from "./process-host.js"

export type { SpawnedWorkerRuntime } from "./worker-host.js"
export { spawnPluginWorker } from "./worker-host.js"

// Bridge client (plugin-side)
export type { BridgeClientOptions, ConfigBridge, SecretBridge, CacheBridge, HostBridge } from "./bridge.js"
export { createBridgeClient } from "./bridge.js"

// Health
export { DEFAULT_LIMITS } from "./health.js"

// Resource limits
export { ConcurrencyLimiter, getProcessMemoryMb, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"

// Bridge enforcement (host-side)
export { bridgeMethodCapability, bridgeMethodPolicy, createBridgeEnforcementHandler } from "./bridge-enforcement.js"
export type { BridgeEnforcementResult } from "./bridge-enforcement.js"

// Log buffer
export { PluginLogBuffer } from "./logs.js"
export type { PluginLogEntry } from "./logs.js"
