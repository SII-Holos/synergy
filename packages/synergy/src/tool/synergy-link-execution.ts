import { SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import type { SynergyLinkClient } from "@ericsanchezok/synergy-link-protocol"

export namespace SynergyLinkExecution {
  export interface SessionRecord {
    linkID: SynergyLinkIdentity.LinkID
    targetAgentID: string
    sessionID: SynergyLinkIdentity.SessionID
    status: "opened" | "closed"
    label?: string
    openedAt: number
    lastUsedAt: number
  }

  export type ExecutionTarget =
    | { kind: "local" }
    | {
        kind: "remote"
        linkID: SynergyLinkIdentity.LinkID
        session: SessionRecord
        client: SynergyLinkClient.ExecutionClient
      }
    | { kind: "local_fallback"; warning: SynergyLinkIdentity.Warning }

  let client: SynergyLinkClient.ExecutionClient | null = null
  const sessions = new Map<SynergyLinkIdentity.LinkID, SessionRecord>()

  export function setClient(next: SynergyLinkClient.ExecutionClient | null) {
    client = next
    if (!next) {
      sessions.clear()
    }
  }

  export function getClient() {
    return client
  }

  export function requireClient(linkID: SynergyLinkIdentity.LinkID, tool: "bash" | "process" | "connect") {
    if (!client) {
      throw new NotConnectedError(linkID, tool)
    }
    return client
  }

  export function getSession(linkID: SynergyLinkIdentity.LinkID) {
    return sessions.get(linkID)
  }

  export function allSessions() {
    return [...sessions.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  }

  export function upsertSession(session: SessionRecord) {
    sessions.set(session.linkID, session)
  }

  export function touchSession(linkID: SynergyLinkIdentity.LinkID) {
    const session = sessions.get(linkID)
    if (session) session.lastUsedAt = Date.now()
    return session
  }

  export function clearSession(linkID: SynergyLinkIdentity.LinkID) {
    const session = sessions.get(linkID)
    sessions.delete(linkID)
    return session
  }

  export function requireSession(linkID: SynergyLinkIdentity.LinkID) {
    const session = sessions.get(linkID)
    if (!session || session.status !== "opened") {
      throw new NoSessionError(linkID)
    }
    session.lastUsedAt = Date.now()
    return session
  }

  export function resolveExecutionTarget(input: {
    linkID?: string
    linkIDSupplied: boolean
    tool: "bash" | "process"
  }): ExecutionTarget {
    if (!input.linkIDSupplied) {
      return { kind: "local" }
    }

    const resolution = SynergyLinkIdentity.resolve(input.linkID)
    if (resolution.kind === "local") {
      return {
        kind: "local_fallback",
        warning: warning("synergy_link.invalid_link_id", input.linkID ?? "", false),
      }
    }

    if (resolution.kind === "invalid") {
      return {
        kind: "local_fallback",
        warning: warning("synergy_link.invalid_link_id", resolution.input, false),
      }
    }

    if (!client) {
      return {
        kind: "local_fallback",
        warning: warning("synergy_link.not_connected", resolution.linkID, true),
      }
    }

    const session = sessions.get(resolution.linkID)
    if (!session || session.status !== "opened") {
      return {
        kind: "local_fallback",
        warning: warning("synergy_link.no_active_session", resolution.linkID, true),
      }
    }

    session.lastUsedAt = Date.now()
    return { kind: "remote", linkID: resolution.linkID, session, client }
  }

  export function withLocalFallbackWarning<T extends { output: string; metadata: Record<string, unknown> }>(
    result: T,
    warning: SynergyLinkIdentity.Warning,
  ): T {
    const warnings = Array.isArray(result.metadata.warnings) ? result.metadata.warnings : []
    return {
      ...result,
      metadata: {
        ...result.metadata,
        backend: "local",
        warnings: [...warnings, warning],
      },
      output: `${visibleWarning(warning)}\n\n${result.output}`,
    }
  }

  export class NotConnectedError extends Error {
    constructor(
      readonly linkID: string,
      readonly tool: "bash" | "process" | "connect",
    ) {
      super(
        `Synergy Link ${tool} execution is not connected for link "${linkID}". ` +
          `Open a Synergy Link session with connect before targeting this linkID.`,
      )
      this.name = "SynergyLinkNotConnectedError"
    }
  }

  export class NoSessionError extends Error {
    constructor(readonly linkID: string) {
      super(`No active Synergy Link session for link "${linkID}". Open a session first with the connect tool.`)
      this.name = "SynergyLinkNoSessionError"
    }
  }

  function warning(
    code: SynergyLinkIdentity.Warning["code"],
    requestedLinkID: string,
    retryable: boolean,
  ): SynergyLinkIdentity.Warning {
    if (code === "synergy_link.invalid_link_id") {
      return {
        code,
        message: `Requested linkID "${requestedLinkID}" is invalid, so this operation ran locally.`,
        reminder: "Omit linkID for intentional local execution. To run remotely, connect a Synergy Link target first.",
        requestedLinkID,
        retryable,
      }
    }
    if (code === "synergy_link.not_connected") {
      return {
        code,
        message: `Requested link "${requestedLinkID}" is not connected, so this operation ran locally.`,
        reminder: "Open a Synergy Link session with connect before targeting this linkID.",
        requestedLinkID,
        retryable,
      }
    }
    return {
      code,
      message: `Requested link "${requestedLinkID}" has no active session, so this operation ran locally.`,
      reminder: "Open a Synergy Link session with connect before remote execution.",
      requestedLinkID,
      retryable,
    }
  }

  function visibleWarning(warning: SynergyLinkIdentity.Warning) {
    return `[Synergy Link warning: ${warning.message} ${warning.reminder}]`
  }
}
