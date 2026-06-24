import type { Info as ScopeInfo } from "../scope/types.js"

// === Direction: Host → Plugin ===

export type HostToPlugin =
  | { type: "init"; pluginId: string; input: IsolatedPluginInputData }
  | { type: "invokeTool"; requestId: string; toolId: string; args: unknown }
  | { type: "triggerHook"; requestId: string; hook: string; input: unknown; output: unknown }
  | { type: "bridgeResponse"; requestId: string; ok: true; value: unknown }
  | { type: "bridgeResponse"; requestId: string; ok: false; error: SerializedError }
  | { type: "reload" }
  | { type: "shutdown" }
  | { type: "ping" }

// === Direction: Plugin → Host ===

export type PluginToHost =
  | { type: "ready"; tools: RuntimeToolDescriptor[]; hooks: string[] }
  | { type: "response"; requestId: string; ok: true; value: unknown }
  | { type: "response"; requestId: string; ok: false; error: SerializedError }
  | { type: "hostRequest"; requestId: string; method: HostBridgeMethod; params: unknown }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "heartbeat" }

// === Bridge methods ===

export type HostBridgeMethod =
  | "config.get"
  | "config.set"
  | "secret.get"
  | "secret.set"
  | "secret.delete"
  | "cache.get"
  | "cache.set"
  | "file.read"
  | "file.write"
  | "network.fetch"
  | "shell.run"
  | "session.getMetadata"
  | "session.read"
  | "workspace.getMetadata"
  | "tool.invoke"
  | "permission.request"

// === Supporting types ===

export interface IsolatedPluginInputData {
  pluginId: string
  pluginDir: string
  scope: ScopeInfo
  directory: string
  serverUrl: string
}

export interface RuntimeToolDescriptor {
  id: string
  description: string
  schema?: unknown
  capabilities?: string[]
}

export interface SerializedError {
  name: string
  message: string
  stack?: string
  cause?: SerializedError
}

// === Protocol constants ===

export const PROTOCOL_VERSION = 1
export const MESSAGE_DELIMITER = "\n"

// === Host bridge handler ===

export type HostBridgeHandler = (requestId: string, method: HostBridgeMethod, params: unknown) => Promise<unknown>
