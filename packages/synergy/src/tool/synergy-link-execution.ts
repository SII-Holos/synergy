import { SynergyLinkIdentity } from "@ericsanchezok/synergy-link-protocol"
import type { SynergyLinkClient } from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkRemoteError, type SynergyLinkTransportFailureReason } from "./remote-error"
import { ToolLinkTargetSource } from "./link-target-source"
import { withTimeout } from "@/util/timeout"
import { ToolTimeout } from "./timeout"

export namespace SynergyLinkExecution {
  export interface SessionRecord {
    linkID: SynergyLinkIdentity.LinkID
    targetID?: string
    targetAgentID: string
    sourceAgent: string
    sessionID: SynergyLinkIdentity.SessionID
    status: "opened" | "closed"
    label?: string
    supportsBashDetach?: boolean
    openedAt: number
    lastUsedAt: number
    lastAttemptAt?: number
    lastVerifiedAt?: number
  }

  export type ExecutionTarget =
    | { kind: "local" }
    | {
        kind: "remote"
        linkID: SynergyLinkIdentity.LinkID
        session: SessionRecord
        client: SynergyLinkClient.ExecutionClient
      }

  type DisposableExecutionClient = SynergyLinkClient.ExecutionClient & {
    dispose?: (reason?: SynergyLinkTransportFailureReason) => void
  }

  let client: DisposableExecutionClient | null = null
  const sessions = new Map<SynergyLinkIdentity.LinkID, Map<string, SessionRecord>>()

  export function setClient(next: DisposableExecutionClient | null, reason?: SynergyLinkTransportFailureReason) {
    if (client === next) return
    client?.dispose?.(reason)
    client = next
    sessions.clear()
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
    const bucket = sessions.get(linkID)
    if (!bucket) return undefined
    if (selector?.targetAgentID) {
      const session = bucket.get(selector.targetAgentID)
      return session && matchesSession(session, selector) ? session : undefined
    }
    const matches = [...bucket.values()].filter((session) => matchesSession(session, selector))
    return matches.length === 1 ? matches[0] : undefined
  }

  export function allSessions() {
    return [...sessions.values()]
      .flatMap((bucket) => [...bucket.values()])
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
  }

  export function upsertSession(session: SessionRecord) {
    const bucket = sessions.get(session.linkID) ?? new Map<string, SessionRecord>()
    bucket.set(session.targetAgentID, session)
    sessions.set(session.linkID, bucket)
  }

  export function touchSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const session = getSession(linkID, selector)
    if (session) session.lastUsedAt = Date.now()
    return session
  }

  export function clearSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const bucket = sessions.get(linkID)
    const session = getSession(linkID, selector)
    if (!bucket || !session) return undefined
    bucket.delete(session.targetAgentID)
    if (bucket.size === 0) sessions.delete(linkID)
    return session
  }

  function clearMatchingSession(
    linkID: SynergyLinkIdentity.LinkID,
    sessionID: SynergyLinkIdentity.SessionID,
    selector?: SessionSelector,
  ): boolean {
    const session = getSession(linkID, selector)
    if (!session || session.sessionID !== sessionID) return false
    clearSession(linkID, selector)
    return true
  }

  export function clearSessionOnInvalidError(
    linkID: SynergyLinkIdentity.LinkID,
    sessionID: SynergyLinkIdentity.SessionID,
    selector: SessionSelector,
    error: unknown,
  ): boolean {
    if (!isInvalidSessionError(error)) return false
    return clearMatchingSession(linkID, sessionID, selector)
  }

  export function requireSession(linkID: SynergyLinkIdentity.LinkID, selector?: SessionSelector) {
    const session = getSession(linkID, selector)
    if (!session || session.status !== "opened") {
      throw new NoSessionError(linkID)
    }
    session.lastUsedAt = Date.now()
    return session
  }

  export const SESSION_VERIFY_TTL_MS = 60_000

  export type SessionVerification =
    | { kind: "verified"; session: SessionRecord }
    | { kind: "unverified"; session: SessionRecord; reason: "timeout" | "transport" }
    | { kind: "missing" }

  /**
   * Heartbeat-verifies a cached opened session before it is trusted for status
   * or remote execution. The cached record is a verified cache, never
   * authority: definitive invalid-session responses clear it, timeouts report
   * unknown and never refresh lastVerifiedAt.
   */
  export async function verifySession(
    linkID: SynergyLinkIdentity.LinkID,
    selector?: SessionSelector,
  ): Promise<SessionVerification> {
    const session = getSession(linkID, selector)
    if (!session || session.status !== "opened") return { kind: "missing" }
    const now = Date.now()
    if (session.lastVerifiedAt !== undefined && now - session.lastVerifiedAt < SESSION_VERIFY_TTL_MS) {
      return { kind: "verified", session }
    }
    const activeClient = client
    if (!activeClient) {
      return { kind: "unverified", session, reason: "transport" }
    }
    session.lastAttemptAt = now
    try {
      const result = await withTimeout(
        activeClient.executeSession(
          linkID,
          { action: "heartbeat", sessionID: session.sessionID },
          { targetAgentID: session.targetAgentID },
        ),
        ToolTimeout.DEFAULTS.connectMs,
        {
          message:
            `Verifying the cached session for link "${linkID}" timed out. ` +
            `The remote session may still be active, but its status is unknown.`,
        },
      )
      if (result.metadata.status === "alive") {
        session.lastVerifiedAt = Date.now()
        session.lastUsedAt = Date.now()
        if (result.metadata.host) {
          session.supportsBashDetach = result.metadata.host.capabilities.supportsBashDetach === true
        }
        return { kind: "verified", session }
      }
      if (result.metadata.status === "closed") {
        clearMatchingSession(linkID, session.sessionID, selector)
        return { kind: "missing" }
      }
      return { kind: "unverified", session, reason: "transport" }
    } catch (error) {
      if (isInvalidSessionError(error)) {
        clearMatchingSession(linkID, session.sessionID, selector)
        return { kind: "missing" }
      }
      return { kind: "unverified", session, reason: isTimeoutError(error) ? "timeout" : "transport" }
    }
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
      const target = await ToolLinkTargetSource.get()?.requireTarget(input.targetID ?? "")
      if (!target) throw new Error(`Synergy Link target not found: ${input.targetID}`)
      if (!target.enabled) throw new Error(`Synergy Link target is disabled: ${target.id}`)
      ToolLinkTargetSource.get()!.assertAgentAccess(target, input.agent)
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
    requireClient(resolution.linkID, input.tool)
    const session = getSession(resolution.linkID)
    if (!session || session.status !== "opened") throw new NoSessionError(resolution.linkID)
    const registeredTarget = await ToolLinkTargetSource.get()?.findRegisteredTarget(
      resolution.linkID,
      session.targetAgentID,
    )
    if (registeredTarget) {
      if (!registeredTarget.enabled) throw new Error(`Synergy Link target is disabled: ${registeredTarget.id}`)
      ToolLinkTargetSource.get()!.assertAgentAccess(registeredTarget, input.agent)
    }
    return resolveRemoteTarget({
      linkID: resolution.linkID,
      targetID: registeredTarget?.id,
      targetAgentID: session.targetAgentID,
      sourceAgent: registeredTarget ? undefined : input.agent,
      tool: input.tool,
    })
  }

  async function resolveRemoteTarget(input: {
    linkID: SynergyLinkIdentity.LinkID
    targetID?: string
    targetAgentID?: string
    sourceAgent?: string
    tool: "bash" | "process"
  }): Promise<Extract<ExecutionTarget, { kind: "remote" }>> {
    const activeClient = requireClient(input.linkID, input.tool)
    const verification = await verifySession(input.linkID, {
      targetID: input.targetID,
      targetAgentID: input.targetAgentID,
      sourceAgent: input.sourceAgent,
    })
    if (verification.kind === "missing") {
      throw new NoSessionError(input.linkID)
    }
    if (verification.kind === "unverified") {
      throw new UnverifiedSessionError(input.linkID, verification.reason)
    }
    const session = verification.session
    session.lastUsedAt = Date.now()
    return { kind: "remote", linkID: input.linkID, session, client: activeClient }
  }

  export interface SessionSelector {
    targetID?: string
    targetAgentID?: string
    sourceAgent?: string
  }

  function matchesSession(session: SessionRecord, selector?: SessionSelector) {
    if (!selector) return true
    if (selector.targetID && session.targetID && session.targetID !== selector.targetID) return false
    if (selector.targetAgentID && session.targetAgentID !== selector.targetAgentID) return false
    if (selector.sourceAgent && session.sourceAgent !== selector.sourceAgent) return false
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

  export class UnverifiedSessionError extends Error {
    constructor(
      readonly linkID: string,
      readonly reason: "timeout" | "transport",
    ) {
      super(
        `The remote session for link "${linkID}" could not be verified ` +
          `(${reason === "timeout" ? "the check timed out" : "transport failure"}). Its status is unknown, so the request was not dispatched. ` +
          `Retry once the link is reachable, or open a fresh session with connect.`,
      )
      this.name = "SynergyLinkUnverifiedSessionError"
    }
  }
  export function isInvalidSessionError(error: unknown): boolean {
    if (!(error instanceof SynergyLinkRemoteError)) return false
    return error.code === "session_invalid" || error.code === "session_not_found" || error.code === "session_required"
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof SynergyLinkRemoteError) return /timed out/i.test(error.message)
  return error instanceof Error && /timed out/i.test(error.message)
}
