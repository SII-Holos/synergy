import { MetaSynergyControlClient } from "./control/client"
import { MetaSynergyHolosAuth, type MetaSynergyHolosAuthSource } from "./holos/auth"
import { MetaSynergyHolosLogin } from "./holos/login"
import { MetaSynergyService } from "./service"
import {
  MetaSynergyStore,
  type MetaSynergyApprovalMode,
  type MetaSynergyAuthState,
  type MetaSynergyPendingRequest,
  type MetaSynergyState,
} from "./state/store"
import { MetaSynergyOwnerRegistry } from "./owner-registry"

export type MetaSynergyTrustSubject = "agent" | "user"

interface SupportedResult<T> {
  available: true
  value: T
}

interface UnsupportedResult {
  available: false
  reason: string
}

type AvailabilityResult<T> = SupportedResult<T> | UnsupportedResult

export namespace MetaSynergyCLIBackend {
  export async function status() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "runtime.status" })
    }
    return await loadSnapshot()
  }

  export async function mode() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "runtime.mode" })
    }
    const state = await MetaSynergyStore.loadState()
    return {
      mode: state.runtimeMode,
      ownership: MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await MetaSynergyService.status(),
    }
  }

  export async function enterManagedMode() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "runtime.enter_managed" })
    }
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "managed"
    MetaSynergyOwnerRegistry.declareLocalOwner(state.ownerRegistry, state.envID ?? `local:${crypto.randomUUID()}`)
    state.connectionStatus = "disconnected"
    await MetaSynergyStore.saveState(state)
    return {
      mode: state.runtimeMode,
      ownership: MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await MetaSynergyService.status(),
    }
  }

  export async function enterStandaloneMode() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "runtime.set_mode", mode: "standalone" })
    }
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "standalone"
    MetaSynergyOwnerRegistry.releaseLocalOwner(state.ownerRegistry)
    state.connectionStatus = "disconnected"
    await MetaSynergyStore.saveState(state)
    return {
      mode: state.runtimeMode,
      ownership: MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await MetaSynergyService.status(),
    }
  }

  export async function login(options?: { agentID?: string; agentSecret?: string }) {
    const result =
      options?.agentID && options?.agentSecret
        ? await MetaSynergyHolosLogin.loginWithExistingCredentials({
            agentID: options.agentID,
            agentSecret: options.agentSecret,
          })
        : await MetaSynergyHolosLogin.login()
    return {
      agentID: result.agentID,
      service: await MetaSynergyService.status(),
    }
  }

  export async function logout() {
    const service = await MetaSynergyService.stop()
    const state = await MetaSynergyStore.loadState()
    state.connectionStatus = "disconnected"
    state.currentSession = undefined
    state.service.desiredState = "stopped"
    state.service.runtimeStatus = "stopped"
    state.service.pid = undefined
    state.service.stoppedAt = Date.now()
    await MetaSynergyStore.saveState(state)
    if (state.runtimeMode !== "managed") {
      await MetaSynergyHolosAuth.clear()
    }
    return {
      service,
      authCleared: state.runtimeMode !== "managed",
    }
  }

  export async function whoami() {
    const snapshot = await loadSnapshot()
    return {
      auth: snapshot.auth,
      mode: snapshot.mode,
      ownership: snapshot.ownership,
      envID: snapshot.state.envID ?? null,
      label: snapshot.state.label ?? null,
      service: snapshot.service,
    }
  }

  export async function reconnect() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "runtime.reconnect" })
    }
    return {
      requested: false,
      service: await MetaSynergyService.status(),
      reason: "Service is not running",
    }
  }

  export async function doctor() {
    const state = await MetaSynergyStore.loadState()
    const service = await MetaSynergyService.status()
    const managed = state.runtimeMode === "managed"
    const authInfo = managed ? { auth: undefined, source: null } : await MetaSynergyHolosAuth.inspect()
    const auth = authInfo.auth
    const ownership = MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry)
    const checks = [
      {
        name: "config_dir",
        ok: true,
        detail: MetaSynergyStore.root(),
      },
      {
        name: "mode",
        ok: true,
        detail: state.runtimeMode,
      },
      {
        name: "local_owner",
        ok: ownership.local.owned,
        detail: ownership.local.activeOwnerID ?? "No local owner declared",
      },
      {
        name: "auth",
        ok: managed ? true : Boolean(auth),
        detail: managed
          ? "Managed mode does not require Holos auth"
          : auth
            ? `agent ${auth.agentID} (${authInfo.source})`
            : "No Holos credentials found",
      },
      {
        name: "service",
        ok: service.running,
        detail: service.running ? `pid ${service.pid}` : "Service is not running",
      },
      {
        name: "connection",
        ok: managed ? state.connectionStatus === "disconnected" : state.connectionStatus === "connected",
        detail: state.connectionStatus,
      },
    ]

    if (auth && !managed) {
      const verification = await MetaSynergyHolosLogin.verifySecret(auth.agentSecret)
      checks.push({
        name: "holos_secret",
        ok: verification.valid,
        detail: verification.valid ? "Credentials accepted by Holos" : verification.reason,
      })
    }

    return {
      ok: checks.every((check) => check.ok),
      checks,
      service,
      mode: state.runtimeMode,
      ownership,
      state: sanitizeState(state),
      auth: sanitizeAuth(auth, authInfo.source),
    }
  }

  export async function collaborationStatus() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "collaboration.status" })
    }
    const state = await MetaSynergyStore.loadState()
    return {
      enabled: state.collaborationEnabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  export async function setCollaborationEnabled(enabled: boolean) {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "collaboration.set", enabled })
    }
    const state = await MetaSynergyStore.loadState()
    state.collaborationEnabled = enabled
    await MetaSynergyStore.saveState(state)
    return {
      enabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  export async function sessionStatus() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "session.status" })
    }
    const snapshot = await loadSnapshot()
    return {
      session: snapshot.state.currentSession ?? null,
      blockedAgentIDs: snapshot.state.blockedAgentIDs,
      service: snapshot.service,
    }
  }

  export async function kickSession(
    block: boolean,
  ): Promise<{ requested: boolean; block: boolean; session: unknown | null }> {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "session.kick", block })
    }
    return {
      requested: false,
      block,
      session: null,
    }
  }

  export async function getApproval(): Promise<AvailabilityResult<{ mode: MetaSynergyApprovalMode }>> {
    return await onlineOnlyAvailability({ action: "approval.get" }, async () => {
      const state = await MetaSynergyStore.loadState()
      return { mode: state.approvalMode }
    })
  }

  export async function setApproval(
    mode: MetaSynergyApprovalMode,
  ): Promise<AvailabilityResult<{ mode: MetaSynergyApprovalMode }>> {
    return await onlineOnlyAvailability({ action: "approval.set", mode }, async () => {
      const state = await MetaSynergyStore.loadState()
      state.approvalMode = mode
      await MetaSynergyStore.saveState(state)
      return { mode }
    })
  }

  export async function listTrust(): Promise<
    AvailabilityResult<{ agents: string[]; users: number[]; blockedAgents: string[] }>
  > {
    return await onlineOnlyAvailability({ action: "trust.list" }, async () => {
      const state = await MetaSynergyStore.loadState()
      return {
        agents: state.trusted.agentIDs,
        users: state.trusted.ownerUserIDs,
        blockedAgents: state.blockedAgentIDs,
      }
    })
  }

  export async function addTrust(
    subject: MetaSynergyTrustSubject,
    value: string,
  ): Promise<AvailabilityResult<{ agents: string[]; users: number[] }>> {
    return await onlineOnlyAvailability({ action: "trust.add", subject, value }, async () => {
      const state = await MetaSynergyStore.loadState()
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
    })
  }

  export async function removeTrust(
    subject: MetaSynergyTrustSubject,
    value: string,
  ): Promise<AvailabilityResult<{ agents: string[]; users: number[] }>> {
    return await onlineOnlyAvailability({ action: "trust.remove", subject, value }, async () => {
      const state = await MetaSynergyStore.loadState()
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
    })
  }

  export async function listRequests(): Promise<AvailabilityResult<{ requests: MetaSynergyPendingRequest[] }>> {
    return await onlineOnlyAvailability({ action: "requests.list" }, async () => {
      const state = await MetaSynergyStore.loadState()
      return { requests: state.pendingRequests }
    })
  }

  export async function showRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: MetaSynergyPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.show", requestID }, async () => {
      const state = await MetaSynergyStore.loadState()
      const request = state.pendingRequests.find((item) => item.id === requestID)
      if (!request) {
        throw new Error(`Unknown request: ${requestID}`)
      }
      return { request }
    })
  }

  export async function approveRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: MetaSynergyPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.approve", requestID }, async () => {
      return await decideRequestOffline(requestID, "approved")
    })
  }

  export async function denyRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: MetaSynergyPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.deny", requestID }, async () => {
      return await decideRequestOffline(requestID, "denied")
    })
  }

  export async function getLabel() {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "label.get" })
    }
    const state = await MetaSynergyStore.loadState()
    return {
      label: state.label ?? null,
    }
  }

  export async function setLabel(label: string | null) {
    if (await MetaSynergyControlClient.isAvailable()) {
      return await MetaSynergyControlClient.request({ action: "label.set", label })
    }
    const state = await MetaSynergyStore.loadState()
    state.label = label ?? undefined
    await MetaSynergyStore.saveState(state)
    return {
      label: state.label ?? null,
    }
  }
}

async function onlineOnly<T>(request: { action: string; [key: string]: unknown }, reason: string): Promise<T> {
  if (!(await MetaSynergyControlClient.isAvailable())) {
    throw new Error(reason)
  }
  return await MetaSynergyControlClient.request<T>(request as never)
}

async function onlineOnlyAvailability<T>(
  request: { action: string; [key: string]: unknown },
  offline: () => Promise<T>,
): Promise<AvailabilityResult<T>> {
  if (await MetaSynergyControlClient.isAvailable()) {
    try {
      return supported(await MetaSynergyControlClient.request<T>(request as never))
    } catch (error) {
      return unsupported(error instanceof Error ? error.message : String(error))
    }
  }
  try {
    return supported(await offline())
  } catch (error) {
    return unsupported(error instanceof Error ? error.message : String(error))
  }
}

async function decideRequestOffline(requestID: string, status: "approved" | "denied") {
  const state = await MetaSynergyStore.loadState()
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

async function loadSnapshot() {
  const [state, service] = await Promise.all([MetaSynergyStore.loadState(), MetaSynergyService.status()])
  const authInfo =
    state.runtimeMode === "managed" ? { auth: undefined, source: null } : await MetaSynergyHolosAuth.inspect()

  return {
    auth: sanitizeAuth(authInfo.auth, authInfo.source),
    mode: state.runtimeMode,
    ownership: MetaSynergyOwnerRegistry.snapshot(state.ownerRegistry),
    state: sanitizeState(state),
    host: {
      envID: state.envID ?? null,
      hostSessionID: state.hostSessionID ?? null,
      label: state.label ?? null,
    },
    service,
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

function unsupported(reason: string): UnsupportedResult {
  return {
    available: false,
    reason,
  }
}

function supported<T>(value: T): SupportedResult<T> {
  return {
    available: true,
    value,
  }
}
