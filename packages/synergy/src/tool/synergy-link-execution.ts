import { SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import type { SynergyLinkClient } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkTargetStore } from "@/synergy-link/target-store"

export namespace SynergyLinkExecution {
  export interface SessionRecord {
    linkID: SynergyLinkIdentity.LinkID
    targetID?: string
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

  export function getSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const session = sessions.get(linkID)
    return session && matchesSession(session, selector) ? session : undefined
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

  export function clearSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const session = getSession(linkID, selector)
    if (session) sessions.delete(linkID)
    return session
  }

  export function requireSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const session = getSession(linkID, selector)
    if (!session || session.status !== "opened") {
      throw new NoSessionError(linkID)
    }
    session.lastUsedAt = Date.now()
    return session
  }

  export async function resolveExecutionTarget(input: {
    targetID?: string
    targetIDSupplied: boolean
    linkID?: string
    linkIDSupplied: boolean
    tool: "bash" | "process"
    agent: string
  }): Promise<ExecutionTarget> {
    if (!input.linkIDSupplied && !input.targetIDSupplied) {
      return { kind: "local" }
    }

    if (input.linkIDSupplied && input.targetIDSupplied) {
      throw new Error("Specify targetID or linkID, not both.")
    }

    if (input.targetIDSupplied) {
      const target = await SynergyLinkTargetStore.require(input.targetID ?? "")
      if (!target.enabled) throw new Error(`Synergy Link target is disabled: ${target.id}`)
      SynergyLinkTargetStore.assertAgentAccess(target, input.agent)
      return resolveRemoteTarget({
        linkID: target.linkID,
        targetID: target.id,
        targetAgentID: target.targetAgentID,
        tool: input.tool,
      })
    }

    const resolution = SynergyLinkIdentity.resolve(input.linkID)
    if (resolution.kind === "invalid") {
      throw new SynergyLinkIdentity.InvalidLinkIDError(resolution.input, resolution.reason)
    }
    if (resolution.kind === "local") {
      throw new SynergyLinkIdentity.InvalidLinkIDError(input.linkID, "missing")
    }
    const remote = resolveRemoteTarget({ linkID: resolution.linkID, tool: input.tool })
    const registeredTarget = await SynergyLinkTargetStore.findByLocator(resolution.linkID, remote.session.targetAgentID)
    if (registeredTarget) {
      if (!registeredTarget.enabled) throw new Error(`Synergy Link target is disabled: ${registeredTarget.id}`)
      SynergyLinkTargetStore.assertAgentAccess(registeredTarget, input.agent)
    }
    return remote
  }

  function resolveRemoteTarget(input: {
    linkID: SynergyLinkIdentity.LinkID
    targetID?: string
    targetAgentID?: string
    tool: "bash" | "process"
  }): Extract<ExecutionTarget, { kind: "remote" }> {
    const activeClient = requireClient(input.linkID, input.tool)
    const session = sessions.get(input.linkID)
    if (!session || session.status !== "opened") {
      throw new NoSessionError(input.linkID)
    }
    if (input.targetID && session.targetID !== input.targetID) {
      throw new NoSessionError(input.linkID)
    }
    if (input.targetAgentID && session.targetAgentID !== input.targetAgentID) {
      throw new NoSessionError(input.linkID)
    }

    session.lastUsedAt = Date.now()
    return { kind: "remote", linkID: input.linkID, session, client: activeClient }
  }

  interface SessionSelector {
    targetID?: string
    targetAgentID?: string
  }

  function matchesSession(session: SessionRecord, selector?: SessionSelector) {
    if (!selector) return true
    if (selector.targetID && session.targetID !== selector.targetID) return false
    if (selector.targetAgentID && session.targetAgentID !== selector.targetAgentID) return false
    return true
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
}
