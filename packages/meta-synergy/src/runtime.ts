import process from "node:process"
import { MetaSynergyControlServer } from "./control/server"
import type { MetaSynergyControlRequest } from "./control/schema"
import { MetaSynergyMigrationRunner } from "./migration"
import { MetaSynergyHost } from "./host"
import { MetaSynergyInboundHandler, type SessionOpenDecision } from "./inbound/handler"
import { MetaSynergyHolosClient } from "./holos/client"
import { MetaSynergyHolosAuth, type MetaSynergyHolosAuthSource } from "./holos/auth"
import { MetaSynergyHolosLogin } from "./holos/login"
import { MetaSynergyLog } from "./log"
import { MetaSynergyOwnerRegistry } from "./owner-registry"
import { RPCHandler } from "./rpc/handler"
import { MetaSynergyLocalService } from "./service/local"
import { SessionManager } from "./session/manager"
import {
  MetaSynergyStore,
  type MetaSynergyApprovalMode,
  type MetaSynergyPendingRequest,
  type MetaSynergyState,
} from "./state/store"

export class MetaSynergyRuntime {
  readonly host: MetaSynergyHost
  readonly sessions: SessionManager
  readonly rpc: RPCHandler
  readonly inbound: MetaSynergyInboundHandler
  readonly control: MetaSynergyControlServer
  state: MetaSynergyState | null = null
  #client: MetaSynergyHolosClient | null = null
  #timers: Array<ReturnType<typeof setInterval>> = []
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectAttempt = 0
  #stopping = false
  #manualReconnectInFlight = false
  #runPromise: Promise<void> | null = null
  #resolveRunPromise: (() => void) | null = null

  private constructor(
    host: MetaSynergyHost,
    sessions: SessionManager,
    rpc: RPCHandler,
    inbound: MetaSynergyInboundHandler,
    control: MetaSynergyControlServer,
  ) {
    this.host = host
    this.sessions = sessions
    this.rpc = rpc
    this.inbound = inbound
    this.control = control
  }

  static async create() {
    await MetaSynergyMigrationRunner.run()
    const state = await MetaSynergyStore.loadState()
    const envID = state.envID ?? `env_${crypto.randomUUID()}`
    const hostSessionID = state.hostSessionID ?? crypto.randomUUID()
    const host = new MetaSynergyHost({ envID, hostSessionID })
    const rpc = new RPCHandler({ envID })
    let runtime!: MetaSynergyRuntime
    const sessions = new SessionManager({
      blockedAgentIDs: state.blockedAgentIDs,
      timeoutMs: state.sessionIdleTimeoutMs,
      onChange: ({ current, blockedAgentIDs }) => {
        if (!runtime?.state) return
        runtime.state.currentSession = current
          ? {
              sessionID: current.sessionID,
              remoteAgentID: current.remoteAgentID,
              remoteOwnerUserID: current.remoteOwnerUserID,
              createdAt: current.createdAt,
              lastSeenAt: current.lastSeenAt,
              label: current.label,
            }
          : undefined
        runtime.state.blockedAgentIDs = blockedAgentIDs
        void MetaSynergyStore.saveState(runtime.state)
      },
    })
    const inbound = new MetaSynergyInboundHandler(rpc, sessions, (input) => runtime.decideSessionOpen(input))
    const control = new MetaSynergyControlServer((request) => runtime.handleControlRequest(request))
    runtime = new MetaSynergyRuntime(host, sessions, rpc, inbound, control)
    const ownerRegistry = await MetaSynergyOwnerRegistry.loadFile()
    runtime.state = {
      ...state,
      envID,
      hostSessionID,
      ownerRegistry,
      currentSession: undefined,
      logs: {
        filePath: state.logs.filePath || MetaSynergyStore.logsPath(),
      },
    }

    await MetaSynergyStore.saveState(runtime.state)
    return runtime
  }

  async login() {
    return await MetaSynergyHolosLogin.login()
  }

  async start(input?: { printLogs?: boolean }) {
    const state = requireState(this)
    this.#stopping = false
    this.#runPromise = new Promise<void>((resolve) => {
      this.#resolveRunPromise = resolve
    })
    state.service.desiredState = "running"
    state.service.runtimeStatus = "starting"
    state.service.pid = process.pid
    state.service.printLogs = input?.printLogs ?? state.service.printLogs
    state.service.startedAt = state.service.startedAt ?? Date.now()
    state.service.stoppedAt = undefined
    state.logs.filePath = MetaSynergyStore.logsPath()
    state.ownerRegistry = MetaSynergyOwnerRegistry.hydrate(state.ownerRegistry)
    MetaSynergyOwnerRegistry.declareLocalOwner(
      state.ownerRegistry,
      state.envID ?? this.host.envID ?? crypto.randomUUID(),
    )
    await MetaSynergyOwnerRegistry.saveFile(state.ownerRegistry)
    state.connectionStatus = state.runtimeMode === "managed" ? "disconnected" : "connecting"
    MetaSynergyLog.configure({ printToConsole: state.service.printLogs })
    await MetaSynergyStore.saveState(state)
    await this.control.start()

    this.#startLoops()
    if (state.runtimeMode === "standalone") {
      const auth = await MetaSynergyHolosAuth.load()
      if (!auth) {
        console.log("No Holos credentials found. Starting login flow.")
        await this.login()
      }

      const nextAuth = await MetaSynergyHolosAuth.load()
      if (!nextAuth) {
        throw new Error("Meta Synergy could not load credentials after login.")
      }

      this.#ensureClient(nextAuth)
      try {
        await this.#connectClient()
      } catch (error) {
        MetaSynergyLog.error("runtime.connection.initial_connect_failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        await this.#setConnectionStatus("disconnected")
        this.#scheduleReconnect("initial_connect_failed")
      }

      console.log(`MetaSynergy running as ${nextAuth.agentID}`)
    } else {
      this.#clearReconnectTimer()
      this.#client = null
      await this.#setConnectionStatus("disconnected")
      console.log("MetaSynergy running in managed mode")
    }

    state.service.runtimeStatus = "running"
    await MetaSynergyStore.saveState(state)

    console.log(`envID: ${this.host.envID}`)
    console.log(`Mode: ${state.runtimeMode}`)
    console.log(`Holos: ${this.state?.connectionStatus ?? "disconnected"}`)
    console.log(`Status: ${this.sessions.current() ? "busy" : "idle"}`)

    process.once("SIGINT", () => {
      void this.stopServerProcess({ exit: true })
    })
    process.once("SIGTERM", () => {
      void this.stopServerProcess({ exit: true })
    })

    await this.#runPromise
  }

  async stopServerProcess(input?: { exit?: boolean }) {
    this.#stopping = true
    this.#clearReconnectTimer()
    this.#stopLoops()
    if (this.state) {
      this.state.connectionStatus = "disconnected"
      this.state.currentSession = undefined
      this.state.service.desiredState = "stopped"
      this.state.service.runtimeStatus = "stopped"
      this.state.service.pid = undefined
      this.state.service.stoppedAt = Date.now()
      this.state.service.lastExitAt = this.state.service.stoppedAt
      await MetaSynergyStore.saveState(this.state)
    }
    await this.#client?.disconnect().catch(() => undefined)
    this.#client = null
    await this.control.stop()
    this.#resolveRunPromise?.()
    this.#resolveRunPromise = null
    this.#runPromise = null
    if (input?.exit) {
      process.exit(0)
    }
  }

  async status() {
    return await this.getStatusPayload()
  }

  async logout() {
    await this.stopServerProcess()
    if (requireState(this).runtimeMode !== "managed") {
      await MetaSynergyHolosAuth.clear()
    }
  }

  async setCollaborationEnabled(enabled: boolean) {
    const state = requireState(this)
    state.collaborationEnabled = enabled
    if (!enabled && this.sessions.current()) {
      this.sessions.kickCurrent(false)
    }
    await MetaSynergyStore.saveState(state)
    return {
      enabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  async getCollaborationStatus() {
    const state = requireState(this)
    return {
      enabled: state.collaborationEnabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  async kickCurrentSession(block = false) {
    const kicked = this.sessions.kickCurrent(block)
    const state = requireState(this)
    state.blockedAgentIDs = this.sessions.blockedAgentIDs()
    await MetaSynergyStore.saveState(state)
    return {
      requested: Boolean(kicked),
      block,
      session: kicked
        ? {
            sessionID: kicked.sessionID,
            remoteAgentID: kicked.remoteAgentID,
            remoteOwnerUserID: kicked.remoteOwnerUserID,
            createdAt: kicked.createdAt,
            lastSeenAt: kicked.lastSeenAt,
            label: kicked.label,
          }
        : null,
    }
  }

  async reconnect() {
    const state = requireState(this)
    if (state.runtimeMode === "managed") {
      return {
        requested: false,
        succeeded: false,
        reason: "Holos is disabled in managed mode",
        service: this.getServiceSnapshot(),
      }
    }

    const succeeded = await this.#reconnectClient()
    if (!succeeded) {
      this.#scheduleReconnect("manual_reconnect_failed")
    }
    return {
      requested: true,
      succeeded,
      service: this.getServiceSnapshot(),
    }
  }

  async getSessionStatus() {
    const state = requireState(this)
    return {
      session: state.currentSession ?? null,
      blockedAgentIDs: state.blockedAgentIDs,
      service: this.getServiceSnapshot(),
    }
  }

  async getMode() {
    const state = requireState(this)
    return {
      mode: state.runtimeMode,
      ownership: this.getOwnershipSnapshot(),
      connectionStatus: state.connectionStatus,
      service: this.getServiceSnapshot(),
    }
  }

  async enterManagedMode() {
    const state = requireState(this)
    state.runtimeMode = "managed"
    state.ownerRegistry = MetaSynergyOwnerRegistry.hydrate(state.ownerRegistry)
    MetaSynergyOwnerRegistry.declareLocalOwner(
      state.ownerRegistry,
      state.envID ?? this.host.envID ?? crypto.randomUUID(),
    )
    await MetaSynergyOwnerRegistry.saveFile(state.ownerRegistry)
    this.#clearReconnectTimer()
    this.#reconnectAttempt = 0
    await this.#client?.disconnect().catch(() => undefined)
    this.#client = null
    await this.#setConnectionStatus("disconnected")
    await MetaSynergyStore.saveState(state)
    return {
      mode: state.runtimeMode,
      ownership: this.getOwnershipSnapshot(),
      connectionStatus: state.connectionStatus,
      service: this.getServiceSnapshot(),
    }
  }

  async getApproval() {
    const state = requireState(this)
    return { mode: state.approvalMode }
  }

  async setApproval(mode: MetaSynergyApprovalMode) {
    const state = requireState(this)
    state.approvalMode = mode
    await MetaSynergyStore.saveState(state)
    return { mode }
  }

  async listTrust() {
    const state = requireState(this)
    return {
      agents: state.trusted.agentIDs,
      users: state.trusted.ownerUserIDs,
      blockedAgents: state.blockedAgentIDs,
    }
  }

  async addTrust(subject: "agent" | "user", value: string) {
    const state = requireState(this)
    if (subject === "agent") {
      if (!state.trusted.agentIDs.includes(value)) {
        state.trusted.agentIDs.push(value)
      }
    } else {
      const userID = Number(value)
      if (!Number.isFinite(userID)) {
        throw new Error(`Invalid user id: ${value}`)
      }
      if (!state.trusted.ownerUserIDs.includes(userID)) {
        state.trusted.ownerUserIDs.push(userID)
      }
    }
    await MetaSynergyStore.saveState(state)
    return {
      agents: state.trusted.agentIDs,
      users: state.trusted.ownerUserIDs,
    }
  }

  async removeTrust(subject: "agent" | "user", value: string) {
    const state = requireState(this)
    if (subject === "agent") {
      state.trusted.agentIDs = state.trusted.agentIDs.filter((item) => item !== value)
    } else {
      const userID = Number(value)
      if (!Number.isFinite(userID)) {
        throw new Error(`Invalid user id: ${value}`)
      }
      state.trusted.ownerUserIDs = state.trusted.ownerUserIDs.filter((item) => item !== userID)
    }
    await MetaSynergyStore.saveState(state)
    return {
      agents: state.trusted.agentIDs,
      users: state.trusted.ownerUserIDs,
    }
  }

  async listRequests() {
    const state = requireState(this)
    return { requests: state.pendingRequests }
  }

  async showRequest(requestID: string) {
    const state = requireState(this)
    const request = state.pendingRequests.find((item) => item.id === requestID)
    if (!request) {
      throw new Error(`Unknown request: ${requestID}`)
    }
    return { request }
  }

  async approveRequest(requestID: string) {
    return await this.#decideRequest(requestID, "approved")
  }

  async denyRequest(requestID: string) {
    return await this.#decideRequest(requestID, "denied")
  }

  async getLabel() {
    const state = requireState(this)
    return { label: state.label ?? null }
  }

  async setLabel(label: string | null) {
    const state = requireState(this)
    state.label = label ?? undefined
    await MetaSynergyStore.saveState(state)
    return { label: state.label ?? null }
  }

  getServiceSnapshot() {
    const state = requireState(this)
    const running = MetaSynergyLocalService.isPidRunning(process.pid)
    return {
      desiredState: state.service.desiredState,
      runtimeStatus: state.service.runtimeStatus,
      running,
      pid: process.pid,
      startedAt: state.service.startedAt,
      stoppedAt: state.service.stoppedAt,
      lastExitAt: state.service.lastExitAt,
      printLogs: state.service.printLogs,
      logPath: state.logs.filePath || MetaSynergyStore.logsPath(),
    }
  }

  getOwnershipSnapshot() {
    const state = requireState(this)
    return MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry)
  }

  async getStatusSnapshot() {
    const state = requireState(this)
    return {
      host: {
        envID: state.envID ?? this.host.envID,
        hostSessionID: state.hostSessionID ?? this.host.hostSessionID,
        label: state.label,
      },
      runtimeMode: state.runtimeMode,
      ownership: this.getOwnershipSnapshot(),
      connectionStatus: state.connectionStatus,
      collaborationEnabled: state.collaborationEnabled,
      approvalMode: state.approvalMode,
      trusted: state.trusted,
      currentSession: state.currentSession ?? null,
      pendingRequests: state.pendingRequests,
      service: state.service,
      logs: state.logs,
    }
  }

  async getStatusPayload() {
    const state = requireState(this)
    const authInfo =
      state.runtimeMode === "managed" ? { auth: undefined, source: null } : await MetaSynergyHolosAuth.inspect()
    return {
      auth: sanitizeAuth(authInfo.auth, authInfo.source),
      mode: state.runtimeMode,
      ownership: this.getOwnershipSnapshot(),
      state: sanitizeState(state),
      session: state.currentSession ?? null,
      envID: state.envID ?? null,
      hostSessionID: state.hostSessionID ?? null,
      host: {
        envID: state.envID ?? null,
        hostSessionID: state.hostSessionID ?? null,
        label: state.label ?? null,
      },
      service: this.getServiceSnapshot(),
    }
  }

  async handleControlRequest(request: MetaSynergyControlRequest) {
    switch (request.action) {
      case "ping":
        return null
      case "service.status":
        return this.getServiceSnapshot()
      case "service.stop":
        setTimeout(() => {
          void this.stopServerProcess({ exit: true })
        }, 10)
        return null
      case "runtime.status":
        return await this.getStatusPayload()
      case "runtime.mode":
        return await this.getMode()
      case "runtime.enter_managed":
      case "runtime.enter_managed_mode":
        return await this.enterManagedMode()
      case "runtime.set_mode":
        if (request.mode === "managed") {
          return await this.enterManagedMode()
        }
        throw new Error(`Unsupported runtime mode transition: ${String(request.mode)}`)
      case "runtime.reconnect":
        return await this.reconnect()
      case "collaboration.status":
        return await this.getCollaborationStatus()
      case "collaboration.set":
        return await this.setCollaborationEnabled(Boolean(request.enabled))
      case "requests.list":
        return await this.listRequests()
      case "requests.show":
        return await this.showRequest(String(request.requestID))
      case "requests.approve":
        return await this.approveRequest(String(request.requestID))
      case "requests.deny":
        return await this.denyRequest(String(request.requestID))
      case "session.status":
        return await this.getSessionStatus()
      case "session.kick":
        return await this.kickCurrentSession(Boolean(request.block))
      case "meta.execute":
        return await this.inbound.handle({
          caller: request.caller,
          body: request.body,
        })
      case "approval.get":
        return await this.getApproval()
      case "approval.set":
        return await this.setApproval(request.mode as MetaSynergyApprovalMode)
      case "trust.list":
        return await this.listTrust()
      case "trust.add":
        return await this.addTrust(request.subject as "agent" | "user", String(request.value))
      case "trust.remove":
        return await this.removeTrust(request.subject as "agent" | "user", String(request.value))
      case "label.get":
        return await this.getLabel()
      case "label.set":
        return await this.setLabel((request.label as string | null | undefined) ?? null)
      case "logs.read":
        return await MetaSynergyLocalService.readLogsFile(this.getServiceSnapshot().logPath, {
          tailLines: request.tailLines as number | undefined,
          since: request.since as string | undefined,
          maxBytes: request.maxBytes as number | undefined,
        })
      default: {
        const unsupported: never = request
        throw new Error(`Unsupported control action: ${String(unsupported)}`)
      }
    }
  }

  async decideSessionOpen(input: {
    caller: { agentID: string; ownerUserID: number }
    label?: string
  }): Promise<SessionOpenDecision> {
    const state = requireState(this)
    const disk = await MetaSynergyStore.loadState()
    state.collaborationEnabled = disk.collaborationEnabled
    state.approvalMode = disk.approvalMode
    state.trusted = disk.trusted
    state.pendingRequests = disk.pendingRequests
    state.label = disk.label
    if (!state.collaborationEnabled) {
      return "deny"
    }

    const decided = this.#consumeMatchingRequestDecision(state.pendingRequests, input)
    if (decided) {
      await MetaSynergyStore.saveState(state)
      return decided
    }

    if (
      state.trusted.agentIDs.includes(input.caller.agentID) ||
      state.trusted.ownerUserIDs.includes(input.caller.ownerUserID)
    ) {
      return "approve"
    }

    if (state.approvalMode === "auto") {
      return "approve"
    }

    if (state.approvalMode === "trusted-only") {
      const pending = state.pendingRequests.find(
        (request) =>
          request.callerAgentID === input.caller.agentID &&
          request.callerOwnerUserID === input.caller.ownerUserID &&
          request.status === "pending",
      )
      if (pending) {
        pending.updatedAt = Date.now()
        pending.requestCount += 1
        pending.label = input.label ?? pending.label
        await MetaSynergyStore.saveState(state)
        return "pending"
      }

      const now = Date.now()
      state.pendingRequests.unshift({
        id: crypto.randomUUID(),
        callerAgentID: input.caller.agentID,
        callerOwnerUserID: input.caller.ownerUserID,
        label: input.label,
        status: "pending",
        requestedAt: now,
        updatedAt: now,
        requestCount: 1,
      })
      await MetaSynergyStore.saveState(state)
      MetaSynergyLog.warn("runtime.collaboration.request.pending", {
        callerAgentID: input.caller.agentID,
        callerOwnerUserID: input.caller.ownerUserID,
        label: input.label,
      })
      return "pending"
    }

    const now = Date.now()
    const pending = state.pendingRequests.find(
      (request) =>
        request.callerAgentID === input.caller.agentID &&
        request.callerOwnerUserID === input.caller.ownerUserID &&
        request.status === "pending",
    )
    if (pending) {
      pending.updatedAt = now
      pending.requestCount += 1
      pending.label = input.label ?? pending.label
      await MetaSynergyStore.saveState(state)
      return "pending"
    }

    state.pendingRequests.unshift({
      id: crypto.randomUUID(),
      callerAgentID: input.caller.agentID,
      callerOwnerUserID: input.caller.ownerUserID,
      label: input.label,
      status: "pending",
      requestedAt: now,
      updatedAt: now,
      requestCount: 1,
    })
    await MetaSynergyStore.saveState(state)
    MetaSynergyLog.warn("runtime.collaboration.request.pending", {
      callerAgentID: input.caller.agentID,
      callerOwnerUserID: input.caller.ownerUserID,
      label: input.label,
    })
    return "pending"
  }

  #consumeMatchingRequestDecision(
    requests: MetaSynergyPendingRequest[],
    input: { caller: { agentID: string; ownerUserID: number }; label?: string },
  ): SessionOpenDecision | undefined {
    const match = requests.find(
      (request) =>
        request.callerAgentID === input.caller.agentID &&
        request.callerOwnerUserID === input.caller.ownerUserID &&
        !request.consumedAt,
    )
    if (!match) return undefined
    if (input.label) {
      match.label = input.label
    }
    if (match.status === "pending") {
      match.updatedAt = Date.now()
      match.requestCount += 1
      return "pending"
    }
    match.updatedAt = Date.now()
    match.consumedAt = match.updatedAt
    return match.status === "approved" ? "approve" : "deny"
  }

  async #decideRequest(requestID: string, status: "approved" | "denied") {
    const state = requireState(this)
    const request = state.pendingRequests.find((item) => item.id === requestID)
    if (!request) {
      throw new Error(`Unknown request: ${requestID}`)
    }
    request.status = status
    request.updatedAt = Date.now()
    request.decidedAt = request.updatedAt
    await MetaSynergyStore.saveState(state)
    return { request }
  }

  #startLoops() {
    this.#stopLoops()
    const idleTimer = setInterval(() => {
      const expired = this.sessions.expireIdle()
      if (expired) {
        MetaSynergyLog.info("runtime.session.expired", {
          sessionID: expired.sessionID,
          remoteAgentID: expired.remoteAgentID,
        })
      }
    }, 30_000)
    idleTimer.unref?.()
    this.#timers = [idleTimer]
  }

  #stopLoops() {
    for (const timer of this.#timers) clearInterval(timer)
    this.#timers = []
  }

  async #connectClient() {
    if (!this.state) return
    if (this.state.runtimeMode === "managed") {
      await this.#setConnectionStatus("disconnected")
      throw new Error("Holos is disabled in managed mode.")
    }
    const auth = await MetaSynergyHolosAuth.load()
    if (!auth) {
      this.state.connectionStatus = "disconnected"
      await MetaSynergyStore.saveState(this.state)
      throw new Error("Meta Synergy could not load credentials.")
    }

    this.#ensureClient(auth)
    const client = this.#client
    if (!client) {
      throw new Error("Meta Synergy could not create Holos client.")
    }

    await this.#setConnectionStatus("connecting")
    try {
      await client.connect()
      this.#reconnectAttempt = 0
      this.#clearReconnectTimer()
      await this.#setConnectionStatus("connected")
    } catch (error) {
      await this.#setConnectionStatus("disconnected")
      throw error
    }
  }

  async #reconnectClient() {
    MetaSynergyLog.info("runtime.connection.reconnect.begin")
    this.#manualReconnectInFlight = true
    this.#clearReconnectTimer()
    await this.#client?.disconnect().catch(() => undefined)
    this.#client = null
    let succeeded = false
    try {
      await this.#connectClient()
      succeeded = true
      MetaSynergyLog.info("runtime.connection.reconnect.completed")
    } catch (error) {
      MetaSynergyLog.error("runtime.connection.reconnect.failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#manualReconnectInFlight = false
    }
    return succeeded
  }

  #ensureClient(auth: { agentID: string; agentSecret: string }) {
    if (this.#client?.auth.agentID === auth.agentID && this.#client?.auth.agentSecret === auth.agentSecret) {
      return
    }
    let client!: MetaSynergyHolosClient
    client = new MetaSynergyHolosClient(auth, this.inbound, {
      onClose: ({ intentional }) => {
        if (this.#client !== client) return
        void this.#handleClientClosed({ intentional })
      },
    })
    this.#client = client
  }

  async #handleClientClosed(input: { intentional: boolean }) {
    await this.#setConnectionStatus("disconnected")
    if (input.intentional || this.#stopping || this.#manualReconnectInFlight || this.state?.runtimeMode === "managed") {
      return
    }
    this.#scheduleReconnect("socket_closed")
  }

  #scheduleReconnect(reason: string) {
    if (this.#stopping || this.#manualReconnectInFlight || this.#reconnectTimer) return
    if (!this.state || this.state.runtimeMode === "managed") return

    const attempt = this.#reconnectAttempt + 1
    const delayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1))
    this.#reconnectAttempt = attempt
    MetaSynergyLog.warn("runtime.connection.reconnect.scheduled", {
      reason,
      attempt,
      delayMs,
    })

    const timer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#performScheduledReconnect()
    }, delayMs)
    timer.unref?.()
    this.#reconnectTimer = timer
  }

  async #performScheduledReconnect() {
    if (this.#stopping || this.#manualReconnectInFlight) return
    try {
      const succeeded = await this.#reconnectClient()
      if (!succeeded) {
        this.#scheduleReconnect("scheduled_reconnect_failed")
      }
    } catch (error) {
      MetaSynergyLog.error("runtime.connection.reconnect.unexpected", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.#scheduleReconnect("scheduled_reconnect_failed")
    }
  }

  #clearReconnectTimer() {
    if (!this.#reconnectTimer) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  async #setConnectionStatus(status: "disconnected" | "connecting" | "connected") {
    if (!this.state) return
    this.state.connectionStatus = status
    await MetaSynergyStore.saveState(this.state)
  }
}

function sanitizeAuth(
  auth: { agentID: string; agentSecret: string } | undefined,
  source: MetaSynergyHolosAuthSource | null,
) {
  return auth
    ? {
        loggedIn: true,
        agentID: auth.agentID,
        source,
      }
    : {
        loggedIn: false,
        agentID: null,
        source: null,
      }
}

function sanitizeState(state: MetaSynergyState) {
  return {
    runtimeMode: state.runtimeMode,
    ownerRegistry: MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry),
    collaborationEnabled: state.collaborationEnabled,
    approvalMode: state.approvalMode,
    trusted: {
      agentIDs: state.trusted.agentIDs,
      ownerUserIDs: state.trusted.ownerUserIDs,
    },
    pendingRequests: state.pendingRequests,
    blockedAgentIDs: state.blockedAgentIDs,
    envID: state.envID ?? null,
    hostSessionID: state.hostSessionID ?? null,
    label: state.label ?? null,
    connectionStatus: state.connectionStatus,
    sessionIdleTimeoutMs: state.sessionIdleTimeoutMs,
    currentSession: state.currentSession ?? null,
    service: state.service,
    logs: state.logs,
  }
}

function requireState(runtime: MetaSynergyRuntime) {
  if (!runtime.state) {
    throw new Error("Runtime state is not initialized.")
  }
  return runtime.state
}
