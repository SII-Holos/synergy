import type { MetaProtocolBash } from "./bash.js"
import type { MetaProtocolEnv } from "./env.js"
import type { MetaProtocolProcess } from "./process.js"
import type { MetaProtocolSession } from "./session.js"

export namespace MetaProtocolClient {
  export interface RemoteExecutionOptions {
    sessionID?: MetaProtocolEnv.SessionID
    targetAgentID?: string
  }

  export interface ExecutionClient {
    executeBash(
      envID: MetaProtocolEnv.EnvID,
      input: MetaProtocolBash.ExecutePayload,
      options?: RemoteExecutionOptions,
    ): Promise<MetaProtocolBash.Result>
    executeProcess(
      envID: MetaProtocolEnv.EnvID,
      input: MetaProtocolProcess.ExecutePayload,
      options?: RemoteExecutionOptions,
    ): Promise<MetaProtocolProcess.Result>
    executeSession(
      envID: MetaProtocolEnv.EnvID,
      input: MetaProtocolSession.ExecutePayload,
      options?: RemoteExecutionOptions,
    ): Promise<MetaProtocolSession.Result>
  }
}
