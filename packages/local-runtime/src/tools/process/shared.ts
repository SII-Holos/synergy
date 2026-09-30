import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"

export type ProcessAction = "list" | "poll" | "log" | "write" | "send-keys" | "kill" | "clear" | "remove"

export interface ProcessParams {
  action: ProcessAction
  processId?: string
  data?: string
  keys?: string[]
  offset?: number
  limit?: number
  block?: boolean
  timeoutSeconds?: number
}

export interface ProcessMetadata {
  action: ProcessAction
  processId?: string
  status?: string
  exitCode?: number
  command?: string
  description?: string
  nextOffset?: number
  processes?: Array<{
    processId: string
    status: string
    command: string
    description?: string
    runtimeMs: number
  }>
}

export interface ProcessResult {
  title: string
  metadata: ProcessMetadata
  output: string
  attachments?: MessageV2.AttachmentPart[]
}
