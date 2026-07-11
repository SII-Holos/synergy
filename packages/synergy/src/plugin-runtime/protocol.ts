import type { PluginActor } from "@ericsanchezok/synergy-plugin"
import type { RuntimeLimits } from "./health.js"

export interface RuntimeActivationData {
  pluginId: string
  version: string
  generation: string
  capabilities: string[]
  runtimeLimits: RuntimeLimits
}

export interface RuntimeInvocationContextData {
  scopeId: string
  sessionId?: string
  directory: string
  actor: PluginActor
}

export type PluginHostServiceMethod =
  | "event.publish"
  | "session.get"
  | "session.abort"
  | "task.start"
  | "task.get"
  | "task.cancel"
  | "workspace.read"
  | "workspace.write"
  | "workspace.metadata"
  | "settings.get"
  | "settings.replace"
  | "secrets.get"
  | "secrets.set"
  | "secrets.delete"
  | "tool.invoke"

export type HostToPlugin =
  | { type: "activate"; input: RuntimeActivationData }
  | {
      type: "invoke"
      requestId: string
      generation: string
      handlerId: string
      input: unknown
      context: RuntimeInvocationContextData
    }
  | { type: "abort"; requestId: string; reason?: string }
  | { type: "hostResponse"; requestId: string; ok: true; value: unknown }
  | { type: "hostResponse"; requestId: string; ok: false; error: SerializedPluginRuntimeError }
  | { type: "shutdown" }
  | { type: "ping" }

export type PluginToHost =
  | { type: "ready"; protocolVersion: number; generation: string; handlerIds: string[] }
  | { type: "response"; requestId: string; generation: string; ok: true; value: unknown }
  | {
      type: "response"
      requestId: string
      generation: string
      ok: false
      error: SerializedPluginRuntimeError
    }
  | {
      type: "hostRequest"
      requestId: string
      invocationId: string
      method: PluginHostServiceMethod
      params: unknown
    }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; details?: Record<string, unknown> }
  | { type: "heartbeat" }

export interface SerializedPluginRuntimeError {
  name: string
  message: string
  stack?: string
  code?: string
}

export const PLUGIN_RUNTIME_PROTOCOL_VERSION = 3
export const PLUGIN_RUNTIME_MESSAGE_DELIMITER = "\n"
