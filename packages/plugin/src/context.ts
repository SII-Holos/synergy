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

export type PluginRuntimeIdentity = {
  hostVersion: string
  pluginVersion: string
  pluginGeneration: string
  protocolVersion: number
}

export type PluginTaskOwner = {
  pluginId: string
  pluginGeneration: string
  scopeId: string
  correlationId: string
}

export type PluginTaskStatus = "queued" | "running" | "completed" | "error" | "cancelled" | "interrupted"

export type PluginTaskOutputConfig =
  | { mode?: "summary" }
  | { mode: "final_response" }
  | { mode: "structured"; schema: Record<string, unknown>; maxRepairTurns?: 0 | 1 | 2 | 3 }

export type PluginTaskOutput =
  | { mode: "summary"; value: string }
  | { mode: "final_response"; value: string }
  | { mode: "structured"; value: unknown }

export type PluginTaskUsage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
}

export type PluginTaskParent = {
  sessionId: string
  messageId: string
}

export const PluginHostServiceErrorCode = {
  TASK_PARENT_REQUIRED: "PLUGIN_TASK_PARENT_REQUIRED",
  TASK_PARENT_SCOPE_MISMATCH: "PLUGIN_TASK_PARENT_SCOPE_MISMATCH",
} as const
export type PluginHostServiceErrorCode = (typeof PluginHostServiceErrorCode)[keyof typeof PluginHostServiceErrorCode]

export type PluginTaskStartInput = {
  subagent: string
  description: string
  prompt: string
  correlationId: string
  parent?: PluginTaskParent
  tools?: Record<string, boolean>
  visibility?: "visible" | "hidden"
  timeoutMs?: number
  output?: PluginTaskOutputConfig
  category?: string
  model?: {
    providerID: string
    modelID: string
  }
}

export type PluginTaskSnapshot = PluginTaskHandle & {
  status: PluginTaskStatus
  owner: PluginTaskOwner
  agent: string
  model?: { providerID: string; modelID: string }
  startedAt: number
  completedAt?: number
  timeoutMs?: number
  outputConfig?: PluginTaskOutputConfig
  output?: PluginTaskOutput
  usage?: PluginTaskUsage
  error?: string
}

export type PluginCortexTaskAfterInput = {
  task: PluginTaskSnapshot
}

export interface TaskHostService {
  start(input: PluginTaskStartInput): Promise<PluginTaskHandle>
  current(): Promise<PluginTaskSnapshot | undefined>
  get(handle: PluginTaskHandle): Promise<PluginTaskSnapshot>
  cancel(handle: PluginTaskHandle): Promise<void>
}

export type BlueprintCreateInput = {
  noteID: string
  sessionID?: string
  runMode?: "current" | "new" | "worktree"
  model?: { providerID: string; modelID: string }
}

export type BlueprintLoopInfo = {
  id: string
  noteID: string
  noteVersion?: number
  title: string
  description?: string
  sessionID: string
  executionAgent?: string
  auditAgent: string
  auditSessionID?: string
  auditTaskID?: string
  scopeID: string
  status: "armed" | "running" | "waiting" | "auditing" | "completed" | "failed" | "cancelled"
  runMode?: "current" | "new" | "worktree"
  parentSessionID?: string
  firstPrompt?: string
  userPrompt?: string
  error?: string
  loopIndex?: number
  source: "user" | "lattice" | "plugin"
  pluginOwner?: {
    pluginId: string
    pluginGeneration: string
    scopeId: string
    correlationId?: string
  }
  audit?: { lastReason?: string; lastAuditedAt?: number; attempts: number }
  time: { created: number; started?: number; updated: number; completed?: number }
  model?: { providerID: string; modelID: string }
}

export type BlueprintAfterInput = {
  loop: BlueprintLoopInfo
}

export interface BlueprintHostService {
  create(input: BlueprintCreateInput): Promise<BlueprintLoopInfo>
  start(loopID: string): Promise<BlueprintLoopInfo>
  get(loopID: string): Promise<BlueprintLoopInfo>
  list(): Promise<BlueprintLoopInfo[]>
  cancel(loopID: string): Promise<BlueprintLoopInfo>
}

export type LightLoopEnableInput = {
  sessionID?: string
  taskDescription: string
}

export interface LightLoopHostService {
  enable(input: LightLoopEnableInput): Promise<void>
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
  runtime: PluginRuntimeIdentity
  actor: PluginActor
  signal: AbortSignal
  log: PluginLogger
  events: ScopedPluginEventPublisher
  session?: SessionHostService
  task?: TaskHostService
  blueprint?: BlueprintHostService
  lightloop?: LightLoopHostService
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
