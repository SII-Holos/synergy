import type { ToolResult } from "./tool.js"

export type PluginActor =
  | { type: "ui" }
  | { type: "sdk"; subject?: string }
  | { type: "agent"; agent: string; messageId: string; callId: string }
  | { type: "lifecycle" }

export interface PluginLogger {
  debug(message: string, details?: Record<string, unknown>): void
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}

export interface ScopedPluginEventPublisher {
  publish(eventId: string, payload: unknown): Promise<void>
}

export interface SessionHostService {
  get?(sessionId: string): Promise<unknown>
  abort?(sessionId: string): Promise<void>
}

export type PluginTaskHandle = {
  taskId: string
  sessionId: string
}

export type PluginTaskParent = {
  sessionId: string
  messageId: string
}

export type PluginTaskStartInput = {
  subagent: string
  description: string
  prompt: string
  correlationId: string
  parent?: PluginTaskParent
  tools?: Record<string, boolean>
  visibility?: "visible" | "hidden"
  timeoutMs?: number
  output?:
    | { mode?: "summary" }
    | { mode: "final_response" }
    | { mode: "structured"; schema: Record<string, unknown>; maxRepairTurns?: 0 | 1 | 2 | 3 }
  category?: string
  model?: {
    providerID: string
    modelID: string
  }
}

export type PluginTaskSnapshot = PluginTaskHandle & {
  status: "pending" | "queued" | "running" | "completed" | "error" | "cancelled" | "interrupted"
  output?:
    | { mode: "summary"; value: string }
    | { mode: "final_response"; value: string }
    | { mode: "structured"; value: unknown }
  error?: string
}

export interface TaskHostService {
  start(input: PluginTaskStartInput): Promise<PluginTaskHandle>
  get(handle: PluginTaskHandle): Promise<PluginTaskSnapshot>
  cancel(handle: PluginTaskHandle): Promise<void>
}

export interface WorkspaceHostService {
  read?(path: string): Promise<string>
  write?(path: string, content: string): Promise<void>
  metadata?(): Promise<unknown>
}

export interface PluginSettingsService {
  get?(): Promise<Record<string, unknown>>
  replace?(values: Record<string, unknown>): Promise<void>
}

export interface PluginSecretsService {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface PluginToolHostService {
  invoke(toolId: string, input: unknown): Promise<ToolResult>
}

export interface PluginInvocationContext {
  requestId: string
  scopeId: string
  sessionId?: string
  actor: PluginActor
  signal: AbortSignal
  log: PluginLogger
  events: ScopedPluginEventPublisher
  session?: SessionHostService
  task?: TaskHostService
  workspace?: WorkspaceHostService
  settings?: PluginSettingsService
  secrets?: PluginSecretsService
  tools?: PluginToolHostService
}

export interface PluginActivationContext {
  pluginId: string
  version: string
  generation: string
  log: PluginLogger
}
