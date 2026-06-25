import { MetaProtocolEnv, MetaProtocolProcess } from "@ericsanchezok/meta-protocol"
import type { MessageV2 } from "@/session/message-v2"

export interface ProcessParams {
  action: MetaProtocolProcess.Action
  processId?: MetaProtocolEnv.ProcessID
  data?: string
  keys?: string[]
  offset?: number
  limit?: number
  block?: boolean
  timeout?: number
  envID?: MetaProtocolEnv.EnvID
}

export type ProcessMetadata = MetaProtocolProcess.ResultMetadata
export type ProcessResult = MetaProtocolProcess.Result & {
  attachments?: MessageV2.FilePart[]
}
