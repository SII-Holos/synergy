import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  directory?: string
  /** Request permission from the user before proceeding */
  ask?(input: { permission: string; patterns: string[]; metadata?: Record<string, any> }): Promise<void>
}

export interface ToolResultDisplay {
  /**
   * `artifact-only` hides the completed tool card and promotes primary
   * attachments into the final turn response area. Running and failed tool
   * states still render normally so progress and errors remain visible.
   */
  presentation?: "default" | "artifact-only"
  primaryAttachmentIds?: string[]
}

export type ToolResultMetadata = Record<string, any> & {
  display?: ToolResultDisplay
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

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string | ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
