import { MetaProtocolEnv } from "@ericsanchezok/meta-protocol"
import type { MetaProtocolClient } from "@ericsanchezok/meta-protocol"

export namespace RemoteExecution {
  export interface SessionRecord {
    envID: MetaProtocolEnv.EnvID
    targetAgentID: string
    sessionID: MetaProtocolEnv.SessionID
    status: "opened" | "closed"
    label?: string
    openedAt: number
    lastUsedAt: number
  }

  export class NotConnectedError extends Error {
    constructor(
      readonly envID: string,
      readonly tool: "bash" | "process" | "connect",
    ) {
      super(
        `Remote ${tool} execution is not connected for env "${envID}". ` +
          `This tool call is being treated as remote because envID was provided. ` +
          `For local execution, do NOT include the envID parameter at all — remove it from your tool call. ` +
          `For remote execution, connect a remote execution client first and then open a connection with the connect tool for that envID.`,
      )
      this.name = "RemoteExecutionNotConnectedError"
    }
  }

  export class NoSessionError extends Error {
    constructor(readonly envID: string) {
      super(
        `No active remote session for env "${envID}". ` +
          `For local execution, do NOT include the envID parameter at all — remove it from your tool call. ` +
          `For remote execution, open a session first with the connect tool.`,
      )
      this.name = "RemoteExecutionNoSessionError"
    }
  }

  let client: MetaProtocolClient.ExecutionClient | null = null
  const sessions = new Map<MetaProtocolEnv.EnvID, SessionRecord>()

  export function resolveTarget(envID?: string) {
    return MetaProtocolEnv.resolve(envID)
  }

  export function normalizeEnvID(envID?: string) {
    return MetaProtocolEnv.normalize(envID)
  }

  export function setClient(next: MetaProtocolClient.ExecutionClient | null) {
    client = next
    if (!next) {
      sessions.clear()
    }
  }

  export function getClient() {
    return client
  }

  export function requireClient(envID: string, tool: "bash" | "process" | "connect") {
    if (!client) {
      throw new NotConnectedError(envID, tool)
    }
    return client
  }

  export function notConnected(envID: string, tool: "bash" | "process" | "connect"): never {
    throw new NotConnectedError(envID, tool)
  }

  export function getSession(envID: string) {
    return sessions.get(envID)
  }

  export function allSessions() {
    return [...sessions.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  }

  export function upsertSession(session: SessionRecord) {
    sessions.set(session.envID, session)
  }

  export function touchSession(envID: string) {
    const session = sessions.get(envID)
    if (session) session.lastUsedAt = Date.now()
    return session
  }

  export function clearSession(envID: string) {
    const session = sessions.get(envID)
    sessions.delete(envID)
    return session
  }

  export function requireSession(envID: string) {
    const session = sessions.get(envID)
    if (!session || session.status !== "opened") {
      throw new NoSessionError(envID)
    }
    session.lastUsedAt = Date.now()
    return session
  }
}
