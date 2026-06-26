import { z } from "zod"
import type { ToolDisplay } from "./display"

export type { ToolDisplay, ToolMediaDisplay } from "./display"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  directory?: string
  /** Request permission from the user before proceeding */
  ask?(input: { permission: string; patterns: string[]; metadata?: Record<string, any> }): Promise<void>
  /** Run a Synergy delegated subagent task from inside this tool. */
  task?: ToolTaskService
  /** Invoke another visible/explicitly-allowed Synergy tool from inside this tool. */
  tools?: ToolInvokeService
}

export type ToolTaskVisibility = "visible" | "hidden"
export type ToolTaskOutput =
  | { mode?: "summary" }
  | { mode: "final_response" }
  | { mode: "structured"; schema: Record<string, unknown>; maxRepairTurns?: 0 | 1 | 2 | 3 }

export type ToolTaskOutputResult =
  | { mode: "final_response"; text: string }
  | {
      mode: "structured"
      status: "valid" | "invalid"
      source?: "structured_tool" | "final_response"
      data?: unknown
      text?: string
      repairTurns: number
      error?: string
      validationErrors?: string[]
    }

export interface ToolTaskRunInput {
  subagent: string
  description: string
  prompt: string
  tools?: Record<string, boolean>
  visibility?: ToolTaskVisibility
  timeoutMs?: number
  output?: ToolTaskOutput
  category?: string
  model?: {
    providerID: string
    modelID: string
  }
}

export interface ToolTaskRunResult {
  taskId: string
  sessionId: string
  status: "pending" | "queued" | "running" | "completed" | "error" | "cancelled" | "timeout"
  output: string
  outputResult?: ToolTaskOutputResult
  error?: string
}

export interface ToolTaskService {
  run(input: ToolTaskRunInput): Promise<ToolTaskRunResult>
}

export interface ToolInvokeInput {
  tool: string
  args?: unknown
  timeoutMs?: number
}

export interface ToolInvokeService {
  invoke(input: ToolInvokeInput): Promise<ToolResult>
}

export type ToolResultMetadata = Record<string, any> & {
  display?: ToolDisplay
  primaryAttachmentIds?: string[]
}

export interface ToolResult {
  title?: string
  output: string
  metadata?: ToolResultMetadata
  attachments?: Array<{
    type: "file"
    id: string
    sessionID: string
    messageID: string
    mime: string
    filename?: string
    url: string
    localPath?: string
  }>
}

export type ToolExposure =
  | {
      mode: "resident"
    }
  | {
      mode: "group"
      group: string
      title?: string
      description?: string
      whenToExpand?: string
    }
  | {
      mode: "search"
      title?: string
      keywords?: string[]
    }
  | {
      mode: "internal"
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  exposure?: ToolExposure
  display?: ToolDisplay
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string | ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
