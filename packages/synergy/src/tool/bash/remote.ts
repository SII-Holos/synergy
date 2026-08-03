import { SynergyLinkExecution } from "../synergy-link-execution"
import type { BashParams } from "./shared"

export namespace RemoteBashBackend {
  export async function execute(
    params: BashParams,
    target: Extract<SynergyLinkExecution.ExecutionTarget, { kind: "remote" }>,
  ) {
    const {
      targetID: _targetID,
      linkID: _linkID,
      backgroundAfterSeconds: _backgroundAfterSeconds,
      timeoutSeconds: _timeoutSeconds,
      ...payload
    } = params
    try {
      return await target.client.executeBash(target.linkID, payload, {
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
