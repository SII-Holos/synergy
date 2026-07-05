import type { SynergyLinkExecution } from "../synergy-link-execution"
import type { BashParams } from "./shared"

export namespace RemoteBashBackend {
  export async function execute(
    params: BashParams,
    target: Extract<SynergyLinkExecution.ExecutionTarget, { kind: "remote" }>,
  ) {
    const { linkID: _linkID, ...payload } = params
    return target.client.executeBash(target.linkID, payload, {
      sessionID: target.session.sessionID,
      targetAgentID: target.session.targetAgentID,
    })
  }
}
