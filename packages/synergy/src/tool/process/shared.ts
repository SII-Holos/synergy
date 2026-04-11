import { MetaProtocolEnv, MetaProtocolProcess } from "@ericsanchezok/meta-protocol"

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
export type ProcessResult = MetaProtocolProcess.Result
