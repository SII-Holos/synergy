import type { SynergyLinkExecution } from "../synergy-link-execution"
import type { BashParams } from "./shared"

export namespace RemoteBashBackend {
  export async function execute(
    params: BashParams,
    target: Extract<SynergyLinkExecution.ExecutionTarget, { kind: "remote" }>,
  ) {
    const {
      targetID: _targetID,
      linkID: _linkID,
      envID: _envID,
      backgroundAfterSeconds: _backgroundAfterSeconds,
      timeoutSeconds: _timeoutSeconds,
      ...payload
    } = params
    return target.client.executeBash(target.linkID, payload, {
      sessionID: target.session.sessionID,
      targetAgentID: target.session.targetAgentID,
    })
  }
}
