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
export { PROTOCOL_VERSION, MESSAGE_DELIMITER } from "./protocol.js"

// Supervisor
export type { RuntimeMode, RuntimeState, RuntimeEntry } from "./supervisor.js"
export {
  getRuntime,
  getAllRuntimes,
  getRuntimeState,
  startRuntime,
  stopRuntime,
  reloadRuntime,
  killRuntime,
} from "./supervisor.js"

// Process host
export type { HostBridgeHandler } from "./process-host.js"
export { spawnPluginProcess } from "./process-host.js"

// Bridge client (plugin-side)
export type { ConfigBridge, SecretBridge, CacheBridge, HostBridge } from "./bridge.js"
export { REQUEST_TIMEOUT_MS, createBridgeClient } from "./bridge.js"

// Health
export {
  DEFAULT_LIMITS,
  startHeartbeatMonitor,
  enforceStartupTimeout,
  createRequestTimeout,
  enforceShutdownTimeout,
} from "./health.js"

// Resource limits
export { ConcurrencyLimiter, getProcessMemoryMb, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"

// Bridge enforcement (host-side)
export { BRIDGE_METHOD_CAPABILITY, createBridgeEnforcementHandler } from "./bridge-enforcement.js"
export type { BridgeEnforcementResult } from "./bridge-enforcement.js"
