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

export interface ToolResult {
  title?: string
  output: string
  metadata?: Record<string, any>
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
