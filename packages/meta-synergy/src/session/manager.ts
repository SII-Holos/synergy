import { MetaProtocolEnv, MetaProtocolError, MetaProtocolSession } from "@ericsanchezok/meta-protocol"
import type { HolosCaller } from "../types"
import { MetaSynergyLog } from "../log"

export interface SessionRecord {
  sessionID: MetaProtocolEnv.SessionID
  remoteAgentID: string
  remoteOwnerUserID: number
  createdAt: number
  lastSeenAt: number
  label?: string
}

export class SessionManager {
  #current: SessionRecord | null = null
  #blocked = new Set<string>()
  #timeoutMs: number
  readonly #onChange?: (input: { current: SessionRecord | null; blockedAgentIDs: string[] }) => void

  constructor(input?: {
    blockedAgentIDs?: string[]
    timeoutMs?: number
    onChange?: (input: { current: SessionRecord | null; blockedAgentIDs: string[] }) => void
  }) {
    for (const agentID of input?.blockedAgentIDs ?? []) this.#blocked.add(agentID)
    this.#timeoutMs = Math.max(60_000, input?.timeoutMs ?? 10 * 60 * 1000)
    this.#onChange = input?.onChange
  }

  current() {
    return this.#current
  }

  blockedAgentIDs() {
    return [...this.#blocked]
  }

  setBlockedAgentIDs(agentIDs: string[]) {
    this.#blocked = new Set(agentIDs)
    this.#emitChange()
  }

  setTimeoutMs(timeoutMs: number) {
    this.#timeoutMs = Math.max(60_000, timeoutMs)
  }

  isBlocked(agentID: string) {
    return this.#blocked.has(agentID)
  }

  async open(caller: HolosCaller, label?: string): Promise<MetaProtocolSession.Result> {
    this.expireIdle()
    MetaSynergyLog.info("session.open.begin", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      label,
      currentSessionID: this.#current?.sessionID,
      currentRemoteAgentID: this.#current?.remoteAgentID,
    })
    if (this.#blocked.has(caller.agentID)) {
      MetaSynergyLog.warn("session.open.blocked", {
        callerAgentID: caller.agentID,
      })
      return this.#sessionResult({
        action: "open",
        status: "refused",
        title: "Session refused",
        output: `Remote agent ${caller.agentID} is blocked.`,
      })
    }

    if (this.#current) {
      MetaSynergyLog.warn("session.open.busy", {
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
    this.#current = {
      sessionID: crypto.randomUUID(),
      remoteAgentID: caller.agentID,
      remoteOwnerUserID: caller.ownerUserID,
      createdAt: now,
      lastSeenAt: now,
      label,
    }

    MetaSynergyLog.info("session.open.created", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      sessionID: this.#current.sessionID,
      label,
    })
    this.#emitChange()

    return this.#sessionResult({
      action: "open",
      status: "opened",
      sessionID: this.#current.sessionID,
      remoteAgentID: this.#current.remoteAgentID,
      remoteOwnerUserID: this.#current.remoteOwnerUserID,
      label: this.#current.label,
      title: "Session opened",
      output: `Opened session ${this.#current.sessionID} for ${caller.agentID}.`,
    })
  }

  async close(caller: HolosCaller, sessionID: string): Promise<MetaProtocolSession.Result> {
    this.expireIdle()
    MetaSynergyLog.info("session.close.begin", {
      callerAgentID: caller.agentID,
      sessionID,
    })
    this.assertCaller(caller, sessionID)
    const current = this.#current
    this.#current = null
    this.#emitChange()
    MetaSynergyLog.info("session.close.completed", {
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

  async heartbeat(caller: HolosCaller, sessionID: string): Promise<MetaProtocolSession.Result> {
    this.expireIdle()
    MetaSynergyLog.info("session.heartbeat", {
      callerAgentID: caller.agentID,
      sessionID,
    })
    this.assertCaller(caller, sessionID)
    if (!this.#current) throw envelopeError("session_invalid", "No active session.")
    this.#current.lastSeenAt = Date.now()
    this.#emitChange()
    return this.#sessionResult({
      action: "heartbeat",
      status: "alive",
      sessionID,
      remoteAgentID: this.#current.remoteAgentID,
      remoteOwnerUserID: this.#current.remoteOwnerUserID,
      title: "Session alive",
      output: `Session ${sessionID} is active.`,
    })
  }

  validateCaller(caller: HolosCaller, sessionID: string) {
    this.expireIdle()
    MetaSynergyLog.info("session.validate", {
      callerAgentID: caller.agentID,
      callerOwnerUserID: caller.ownerUserID,
      sessionID,
      currentSessionID: this.#current?.sessionID,
      currentRemoteAgentID: this.#current?.remoteAgentID,
    })
    if (!sessionID) throw envelopeError("session_required", "sessionID is required.")
    this.assertCaller(caller, sessionID)
    if (this.#current) {
      this.#current.lastSeenAt = Date.now()
      this.#emitChange()
    }
  }

  kickCurrent(block = false) {
    if (!this.#current) return undefined
    const current = this.#current
    this.#current = null
    if (block) this.#blocked.add(current.remoteAgentID)
    this.#emitChange()
    MetaSynergyLog.warn("session.kicked", {
      sessionID: current.sessionID,
      remoteAgentID: current.remoteAgentID,
      remoteOwnerUserID: current.remoteOwnerUserID,
      blocked: block,
    })
    return current
  }

  expireIdle(now = Date.now()) {
    if (!this.#current) return undefined
    if (now - this.#current.lastSeenAt < this.#timeoutMs) return undefined
    const expired = this.#current
    this.#current = null
    this.#emitChange()
    MetaSynergyLog.warn("session.expired.idle_timeout", {
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

  #sessionResult(input: {
    action: MetaProtocolSession.Action
    status: MetaProtocolSession.Status
    title: string
    output: string
    sessionID?: string
    remoteAgentID?: string
    remoteOwnerUserID?: number
    label?: string
  }): MetaProtocolSession.Result {
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

  #emitChange() {
    this.#onChange?.({
      current: this.#current,
      blockedAgentIDs: this.blockedAgentIDs(),
    })
  }
}

function envelopeError(
  code: MetaProtocolError.Code,
  message: string,
): { code: MetaProtocolError.Code; message: string } {
  return { code, message }
}
