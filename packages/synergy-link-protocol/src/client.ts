import type { SynergyLinkBash } from "./bash"
import type { SynergyLinkIdentity } from "./identity"
import type { SynergyLinkProcess } from "./process"
import type { SynergyLinkSession } from "./session"

export namespace SynergyLinkClient {
  export interface LinkExecutionOptions {
    sessionID?: SynergyLinkIdentity.SessionID
    targetAgentID?: string
  }

  export interface ExecutionClient {
    executeBash(
      linkID: SynergyLinkIdentity.LinkID,
      input: SynergyLinkBash.ExecutePayload,
      options?: LinkExecutionOptions,
    ): Promise<SynergyLinkBash.Result>
    executeProcess(
      linkID: SynergyLinkIdentity.LinkID,
      input: SynergyLinkProcess.ExecutePayload,
      options?: LinkExecutionOptions,
    ): Promise<SynergyLinkProcess.Result>
    executeSession(
      linkID: SynergyLinkIdentity.LinkID,
      input: SynergyLinkSession.ExecutePayload,
      options?: LinkExecutionOptions,
    ): Promise<SynergyLinkSession.Result>
  }
}
