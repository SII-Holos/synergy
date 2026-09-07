import { SynergyLinkProcess } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkExecution } from "../synergy-link-execution"
import type { ProcessParams, ProcessResult } from "./shared"

// Remote blocking polls must return before the sender's 30-second transport
// deadline. The requested timeout is capped at 25 seconds with the same
// 5-second response margin that remote bash yields reserve, so even a host
// that honors the full requested wait (for example an older deployment)
// returns a still-running result inside the transport window.
const REMOTE_MAX_BLOCKING_POLL_SECONDS = 25

function toPayload(params: ProcessParams): SynergyLinkProcess.ExecutePayload {
  switch (params.action) {
    case "list":
      return { action: "list" }
    case "poll":
      if (!params.processId) throw new Error("processId is required for poll")
      if (params.block) {
        const timeout =
          params.timeout === undefined
            ? REMOTE_MAX_BLOCKING_POLL_SECONDS
            : Math.min(params.timeout, REMOTE_MAX_BLOCKING_POLL_SECONDS)
        return { action: "poll", processId: params.processId, block: true, timeout }
      }
      return { action: "poll", processId: params.processId, block: false }
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
  export async function execute(
    params: ProcessParams,
    target: Extract<SynergyLinkExecution.ExecutionTarget, { kind: "remote" }>,
  ): Promise<ProcessResult> {
    try {
      return await target.client.executeProcess(target.linkID, toPayload(params), {
        sessionID: target.session.sessionID,
        targetAgentID: target.session.targetAgentID,
      })
    } catch (error) {
      SynergyLinkExecution.clearSessionOnInvalidError(
        target.linkID,
        target.session.sessionID,
        {
          targetID: target.session.targetID,
          targetAgentID: target.session.targetAgentID,
          sourceAgent: target.session.sourceAgent,
        },
        error,
      )
      throw error
    }
  }
}
