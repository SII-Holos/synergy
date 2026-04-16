import { MetaProtocolProcess } from "@ericsanchezok/meta-protocol"
import { RemoteExecution } from "../remote-execution"
import type { ProcessParams, ProcessResult } from "./shared"

function toPayload(params: ProcessParams): MetaProtocolProcess.ExecutePayload {
  switch (params.action) {
    case "list":
      return { action: "list" }
    case "poll":
      if (!params.processId) throw new Error("processId is required for poll")
      return { action: "poll", processId: params.processId, block: params.block, timeout: params.timeout }
    case "log":
      if (!params.processId) throw new Error("processId is required for log")
      return { action: "log", processId: params.processId, offset: params.offset, limit: params.limit }
    case "write":
      if (!params.processId) throw new Error("processId is required for write")
      return { action: "write", processId: params.processId, data: params.data ?? "" }
    case "send-keys":
      if (!params.processId) throw new Error("processId is required for send-keys")
      return { action: "send-keys", processId: params.processId, keys: params.keys ?? [] }
    case "kill":
      if (!params.processId) throw new Error("processId is required for kill")
      return { action: "kill", processId: params.processId }
    case "clear":
      if (!params.processId) throw new Error("processId is required for clear")
      return { action: "clear", processId: params.processId }
    case "remove":
      if (!params.processId) throw new Error("processId is required for remove")
      return { action: "remove", processId: params.processId }
  }
}

export namespace RemoteProcessBackend {
  export async function execute(params: ProcessParams, envID: string): Promise<ProcessResult> {
    const session = RemoteExecution.requireSession(envID)
    const client = RemoteExecution.requireClient(envID, "process")
    return client.executeProcess(envID, toPayload(params), {
      sessionID: session.sessionID,
      targetAgentID: session.targetAgentID,
    })
  }
}
