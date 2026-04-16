import { RemoteExecution } from "../remote-execution"
import type { BashBackend } from "./shared"

export const RemoteBashBackend: BashBackend = {
  async execute(params) {
    if (!params.envID) {
      throw new Error("Remote bash backend requires envID")
    }

    const session = RemoteExecution.requireSession(params.envID)
    const client = RemoteExecution.requireClient(params.envID, "bash")
    const { envID, ...payload } = params
    return client.executeBash(envID, payload, {
      sessionID: session.sessionID,
      targetAgentID: session.targetAgentID,
    })
  },
}
