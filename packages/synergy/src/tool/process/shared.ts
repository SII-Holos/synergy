import { SynergyLinkProcess } from "@ericsanchezok/synergy-link-protocol"
import type { MessageV2 } from "@/session/message-v2"

export interface ProcessParams {
  action: SynergyLinkProcess.Action
  processId?: string
  data?: string
  keys?: string[]
  offset?: number
  limit?: number
  block?: boolean
  timeout?: number
  targetID?: string
  linkID?: string
  envID?: string
}

export type ProcessMetadata = SynergyLinkProcess.ResultMetadata
export type ProcessResult = SynergyLinkProcess.Result & {
  attachments?: MessageV2.AttachmentPart[]
}
