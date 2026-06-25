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
