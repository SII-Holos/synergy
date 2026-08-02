import { SynergyLinkIdentity, SynergyLinkError, SynergyLinkSession } from "@ericsanchezok/synergy-link-protocol"
import type { ExecutionLease, HolosCaller } from "../types"
import { SynergyLinkLog } from "../log"

export interface SessionRecord {
  sessionID: SynergyLinkIdentity.SessionID
  remoteAgentID: string
  remoteOwnerUserID: number
  createdAt: number
  lastSeenAt: number
  label?: string
}

export type SessionEndReason = "closed" | "kicked" | "expired"

export class SessionManager {
  #current: SessionRecord | null = null
  #blocked = new Set<string>()
  #timeoutMs: number
  readonly #onChange?: (input: { current: SessionRecord | null; blockedAgentIDs: string[] }) => void | Promise<void>
  readonly #onEnd?: (session: SessionRecord, reason: SessionEndReason) => void | Promise<void>

  constructor(input?: {
    blockedAgentIDs?: string[]
    timeoutMs?: number
    onChange?: (input: { current: SessionRecord | null; blockedAgentIDs: string[] }) => void | Promise<void>
    onEnd?: (session: SessionRecord, reason: SessionEndReason) => void | Promise<void>
  }) {
    for (const agentID of input?.blockedAgentIDs ?? []) this.#blocked.add(agentID)
    this.#timeoutMs = Math.max(60_000, input?.timeoutMs ?? 10 * 60 * 1000)
    this.#onChange = input?.onChange
    this.#onEnd = input?.onEnd
  }

  current() {
    return this.#current
  }

  blockedAgentIDs() {
    return [...this.#blocked]
  }

  async setBlockedAgentIDs(agentIDs: string[]) {
    this.#blocked = new Set(agentIDs)
    await this.#emitChange()
  }

  setTimeoutMs(timeoutMs: number) {
    this.#timeoutMs = Math.max(60_000, timeoutMs)
  }

  isBlocked(agentID: string) {
    return this.#blocked.has(agentID)
  }

  async open(caller: HolosCaller, label?: string): Promise<SynergyLinkSession.Result> {
    await this.expireIdle()
    SynergyLinkLog.info("session.open.begin", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      label,
      currentSessionID: this.#current?.sessionID,
      currentRemoteAgentID: this.#current?.remoteAgentID,
    })
    if (this.#blocked.has(caller.agentID)) {
      return this.#blockedResult(caller.agentID)
    }

    if (
      this.#current &&
      this.#current.remoteAgentID === caller.agentID &&
      this.#current.remoteOwnerUserID === caller.ownerUserID
    ) {
      this.#current.lastSeenAt = Date.now()
      await this.#emitChange()
      SynergyLinkLog.info("session.open.reused", {
        callerAgentID: caller.agentID,
        callerOwnerUserID: caller.ownerUserID,
        sessionID: this.#current.sessionID,
      })
      return this.#sessionResult({
        action: "open",
        status: "opened",
        sessionID: this.#current.sessionID,
        remoteAgentID: this.#current.remoteAgentID,
        remoteOwnerUserID: this.#current.remoteOwnerUserID,
        label: this.#current.label,
        title: "Session opened",
        output: `Session ${this.#current.sessionID} is already open for ${caller.agentID}.`,
      })
    }
    if (this.#current) {
      SynergyLinkLog.warn("session.open.busy", {
        callerAgentID: caller.agentID,
        currentSessionID: this.#current.sessionID,
        currentRemoteAgentID: this.#current.remoteAgentID,
      })
      return this.#sessionResult({
        action: "open",
        status: "busy",
        sessionID: this.#current.sessionID,
        remoteAgentID: this.#current.remoteAgentID,
        remoteOwnerUserID: this.#current.remoteOwnerUserID,
        title: "Session busy",
        output: `Host is busy with session ${this.#current.sessionID}.`,
      })
    }

    const now = Date.now()
    const opened: SessionRecord = {
      sessionID: crypto.randomUUID(),
      remoteAgentID: caller.agentID,
      remoteOwnerUserID: caller.ownerUserID,
      createdAt: now,
      lastSeenAt: now,
      label,
    }
    this.#current = opened

    SynergyLinkLog.info("session.open.created", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      sessionID: opened.sessionID,
      label,
    })
    await this.#emitChange()

    if (this.#blocked.has(caller.agentID)) {
      if (this.#current?.sessionID === opened.sessionID) {
        await this.#endCurrent(opened, "kicked")
      }
      return this.#blockedResult(caller.agentID)
    }

    return this.#sessionResult({
      action: "open",
      status: "opened",
      sessionID: opened.sessionID,
      remoteAgentID: opened.remoteAgentID,
      remoteOwnerUserID: opened.remoteOwnerUserID,
      label: opened.label,
      title: "Session opened",
      output: `Opened session ${opened.sessionID} for ${caller.agentID}.`,
    })
  }

  async close(caller: HolosCaller, sessionID: string): Promise<SynergyLinkSession.Result> {
    await this.expireIdle()
    SynergyLinkLog.info("session.close.begin", {
      callerAgentID: caller.agentID,
      sessionID,
    })
    this.assertCaller(caller, sessionID)
    const current = this.#current
    if (!current) throw envelopeError("session_invalid", "No active collaboration session.")
    await this.#endCurrent(current, "closed")
    SynergyLinkLog.info("session.close.completed", {
      callerAgentID: caller.agentID,
      sessionID,
    })
    return this.#sessionResult({
      action: "close",
      status: "closed",
      sessionID,
      remoteAgentID: current?.remoteAgentID,
      remoteOwnerUserID: current?.remoteOwnerUserID,
      title: "Session closed",
      output: `Closed session ${sessionID}.`,
    })
  }

  async heartbeat(caller: HolosCaller, sessionID: string): Promise<SynergyLinkSession.Result> {
    await this.expireIdle()
    SynergyLinkLog.info("session.heartbeat", {
      callerAgentID: caller.agentID,
      sessionID,
    })
    this.assertCaller(caller, sessionID)
    const current = this.#current!
    current.lastSeenAt = Date.now()
    await this.#emitChange()
    return this.#sessionResult({
      action: "heartbeat",
      status: "alive",
      sessionID,
      remoteAgentID: current.remoteAgentID,
      remoteOwnerUserID: current.remoteOwnerUserID,
      title: "Session alive",
      output: `Session ${sessionID} is active.`,
    })
  }

  async validateCaller(caller: HolosCaller, sessionID: string): Promise<ExecutionLease> {
    await this.expireIdle()
    SynergyLinkLog.info("session.validate", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      sessionID,
      currentSessionID: this.#current?.sessionID,
      currentRemoteAgentID: this.#current?.remoteAgentID,
    })
    if (!sessionID) throw envelopeError("session_required", "sessionID is required.")
    this.assertCaller(caller, sessionID)
    this.#current!.lastSeenAt = Date.now()
    await this.#emitChange()
    this.assertCaller(caller, sessionID)
    return {
      sessionID: this.#current!.sessionID,
      callerAgentID: this.#current!.remoteAgentID,
      callerOwnerUserID: this.#current!.remoteOwnerUserID,
    }
  }

  assertLeaseActive(lease: ExecutionLease) {
    const current = this.#current
    if (
      !current ||
      current.sessionID !== lease.sessionID ||
      current.remoteAgentID !== lease.callerAgentID ||
      current.remoteOwnerUserID !== lease.callerOwnerUserID
    ) {
      throw envelopeError("session_invalid", "The validated Synergy Link session is no longer active.")
    }
  }

  async kickCurrent(block = false) {
    if (!this.#current) return undefined
    const current = this.#current
    if (block) this.#blocked.add(current.remoteAgentID)
    await this.#endCurrent(current, "kicked")
    SynergyLinkLog.warn("session.kicked", {
      sessionID: current.sessionID,
      remoteAgentID: current.remoteAgentID,
      remoteOwnerUserID: current.remoteOwnerUserID,
      blocked: block,
    })
    return current
  }

  async expireIdle(now = Date.now()) {
    if (!this.#current) return undefined
    if (now - this.#current.lastSeenAt < this.#timeoutMs) return undefined
    const expired = this.#current
    await this.#endCurrent(expired, "expired")
    SynergyLinkLog.warn("session.expired.idle_timeout", {
      sessionID: expired.sessionID,
      remoteAgentID: expired.remoteAgentID,
      idleMs: now - expired.lastSeenAt,
      timeoutMs: this.#timeoutMs,
    })
    return expired
  }

  private assertCaller(caller: HolosCaller, sessionID: string) {
    if (!this.#current) {
      throw envelopeError("session_invalid", "No active collaboration session.")
    }
    if (this.#current.sessionID !== sessionID) {
      throw envelopeError("session_invalid", `Session ${sessionID} is not active.`)
    }
    if (this.#current.remoteAgentID !== caller.agentID || this.#current.remoteOwnerUserID !== caller.ownerUserID) {
      throw envelopeError("session_caller_mismatch", `Session ${sessionID} does not belong to ${caller.agentID}.`)
    }
  }

  #blockedResult(agentID: string): SynergyLinkSession.Result {
    SynergyLinkLog.warn("session.open.blocked", {
      callerAgentID: agentID,
    })
    return this.#sessionResult({
      action: "open",
      status: "refused",
      title: "Session refused",
      output: `Remote agent ${agentID} is blocked.`,
    })
  }

  #sessionResult(input: {
    action: SynergyLinkSession.Action
    status: SynergyLinkSession.Status
    title: string
    output: string
    sessionID?: string
    remoteAgentID?: string
    remoteOwnerUserID?: number
    label?: string
  }): SynergyLinkSession.Result {
    return {
      title: input.title,
      metadata: {
        action: input.action,
        status: input.status,
        sessionID: input.sessionID,
        remoteAgentID: input.remoteAgentID,
        remoteOwnerUserID: input.remoteOwnerUserID,
        label: input.label,
        backend: "remote",
      },
      output: input.output,
    }
  }

  async #endCurrent(session: SessionRecord, reason: SessionEndReason) {
    if (this.#current?.sessionID === session.sessionID) this.#current = null
    const [cleanup, change] = await Promise.allSettled([this.#onEnd?.(session, reason), this.#emitChange()])
    if (cleanup.status === "rejected") throw cleanup.reason
    if (change.status === "rejected") throw change.reason
  }

  async #emitChange() {
    await this.#onChange?.({
      current: this.#current,
      blockedAgentIDs: this.blockedAgentIDs(),
    })
  }
}

function envelopeError(code: SynergyLinkError.Code, message: string): { code: SynergyLinkError.Code; message: string } {
  return { code, message }
}
