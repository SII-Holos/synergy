import { SynergyLinkControlClient } from "./control/client"
import { SynergyLinkHolosAuth, type SynergyLinkHolosAuthSource } from "./holos/auth"
import { SynergyLinkHolosLogin } from "./holos/login"
import { SynergyLinkService } from "./service"
import {
  SynergyLinkStore,
  type SynergyLinkApprovalMode,
  type SynergyLinkAuthState,
  type SynergyLinkPendingRequest,
  type SynergyLinkState,
} from "./state/store"
import { SynergyLinkDisplay, type SynergyLinkHiddenReason } from "./display"
import { SynergyLinkOwnerRegistry } from "./owner-registry"

export type SynergyLinkTrustSubject = "agent" | "user"

interface SupportedResult<T> {
  available: true
  value: T
}

interface UnsupportedResult {
  available: false
  reason: string
}

type AvailabilityResult<T> = SupportedResult<T> | UnsupportedResult

export namespace SynergyLinkCLIBackend {
  export async function status() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "runtime.status" })
    }
    return await loadSnapshot()
  }

  export async function mode() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "runtime.mode" })
    }
    const state = await SynergyLinkStore.loadState()
    return {
      mode: state.runtimeMode,
      ownership: SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await SynergyLinkService.status(),
    }
  }

  export async function enterManagedMode() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "runtime.enter_managed" })
    }
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "managed"
    SynergyLinkOwnerRegistry.declareLocalOwner(state.ownerRegistry, state.linkID ?? `local:${crypto.randomUUID()}`)
    state.connectionStatus = "disconnected"
    await SynergyLinkStore.saveState(state)
    return {
      mode: state.runtimeMode,
      ownership: SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await SynergyLinkService.status(),
    }
  }

  export async function enterStandaloneMode() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "runtime.set_mode", mode: "standalone" })
    }
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "standalone"
    SynergyLinkOwnerRegistry.releaseLocalOwner(state.ownerRegistry)
    state.connectionStatus = "disconnected"
    await SynergyLinkStore.saveState(state)
    return {
      mode: state.runtimeMode,
      ownership: SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry),
      connectionStatus: state.connectionStatus,
      service: await SynergyLinkService.status(),
    }
  }

  export async function login(options?: { agentID?: string; agentSecret?: string }) {
    const result =
      options?.agentID && options?.agentSecret
        ? await SynergyLinkHolosLogin.loginWithExistingCredentials({
            agentID: options.agentID,
            agentSecret: options.agentSecret,
          })
        : await SynergyLinkHolosLogin.login()
    return {
      agentID: result.agentID,
      service: await SynergyLinkService.status(),
    }
  }

  export async function logout() {
    const service = await SynergyLinkService.stop()
    const state = await SynergyLinkStore.loadState()
    state.connectionStatus = "disconnected"
    state.currentSession = undefined
    state.service.desiredState = "stopped"
    state.service.runtimeStatus = "stopped"
    state.service.pid = undefined
    state.service.stoppedAt = Date.now()
    await SynergyLinkStore.saveState(state)
    if (state.runtimeMode !== "managed") {
      await SynergyLinkHolosAuth.clear()
    }
    return {
      service,
      authCleared: state.runtimeMode !== "managed",
    }
  }

  export async function whoami() {
    const snapshot = await loadSnapshot()
    const storedAuth = await SynergyLinkHolosAuth.inspect()
    return {
      auth: sanitizeAuth(storedAuth.auth, storedAuth.source),
      mode: snapshot.mode,
      ownership: snapshot.ownership,
      linkID: snapshot.state.linkID ?? null,
      label: snapshot.state.label ?? null,
      service: snapshot.service,
    }
  }

  export async function reconnect() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "runtime.reconnect" })
    }
    return {
      requested: false,
      service: await SynergyLinkService.status(),
      reason: "Service is not running",
    }
  }

  export async function doctor() {
    const state = await SynergyLinkStore.loadState()
    const service = await SynergyLinkService.status()
    const managed = state.runtimeMode === "managed"
    const authInfo = await SynergyLinkHolosAuth.inspect()
    const auth = authInfo.auth
    const ownership = SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry)
    const checks = [
      {
        name: "config_dir",
        ok: true,
        detail: SynergyLinkStore.root(),
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
          ? auth
            ? `Stored agent ${SynergyLinkDisplay.identifier(auth.agentID, { hiddenReason: "managed" })} (${authInfo.source}) — not required in managed mode`
            : "Managed mode does not require Holos auth"
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
      const verification = await SynergyLinkHolosLogin.verifySecret(auth.agentSecret)
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
      auth: sanitizeAuth(auth, authInfo.source, {
        hiddenReason: managed ? "managed" : null,
      }),
    }
  }

  export async function collaborationStatus() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "collaboration.status" })
    }
    const state = await SynergyLinkStore.loadState()
    return {
      enabled: state.collaborationEnabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  export async function setCollaborationEnabled(enabled: boolean) {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "collaboration.set", enabled })
    }
    const state = await SynergyLinkStore.loadState()
    state.collaborationEnabled = enabled
    await SynergyLinkStore.saveState(state)
    return {
      enabled,
      session: state.currentSession ?? null,
      approvalMode: state.approvalMode,
      pendingRequestCount: state.pendingRequests.filter((request) => request.status === "pending").length,
    }
  }

  export async function sessionStatus() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "session.status" })
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
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "session.kick", block })
    }
    return {
      requested: false,
      block,
      session: null,
    }
  }

  export async function getApproval(): Promise<AvailabilityResult<{ mode: SynergyLinkApprovalMode }>> {
    return await onlineOnlyAvailability({ action: "approval.get" }, async () => {
      const state = await SynergyLinkStore.loadState()
      return { mode: state.approvalMode }
    })
  }

  export async function setApproval(
    mode: SynergyLinkApprovalMode,
  ): Promise<AvailabilityResult<{ mode: SynergyLinkApprovalMode }>> {
    return await onlineOnlyAvailability({ action: "approval.set", mode }, async () => {
      const state = await SynergyLinkStore.loadState()
      state.approvalMode = mode
      await SynergyLinkStore.saveState(state)
      return { mode }
    })
  }

  export async function listTrust(): Promise<
    AvailabilityResult<{ agents: string[]; users: number[]; blockedAgents: string[] }>
  > {
    return await onlineOnlyAvailability({ action: "trust.list" }, async () => {
      const state = await SynergyLinkStore.loadState()
      return {
        agents: state.trusted.agentIDs,
        users: state.trusted.ownerUserIDs,
        blockedAgents: state.blockedAgentIDs,
      }
    })
  }

  export async function addTrust(
    subject: SynergyLinkTrustSubject,
    value: string,
  ): Promise<AvailabilityResult<{ agents: string[]; users: number[] }>> {
    return await onlineOnlyAvailability({ action: "trust.add", subject, value }, async () => {
      const state = await SynergyLinkStore.loadState()
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
      await SynergyLinkStore.saveState(state)
      return {
        agents: state.trusted.agentIDs,
        users: state.trusted.ownerUserIDs,
      }
    })
  }

  export async function removeTrust(
    subject: SynergyLinkTrustSubject,
    value: string,
  ): Promise<AvailabilityResult<{ agents: string[]; users: number[] }>> {
    return await onlineOnlyAvailability({ action: "trust.remove", subject, value }, async () => {
      const state = await SynergyLinkStore.loadState()
      if (subject === "agent") {
        state.trusted.agentIDs = state.trusted.agentIDs.filter((item) => item !== value)
      } else {
        const userID = Number(value)
        if (!Number.isFinite(userID)) {
          throw new Error(`Invalid user id: ${value}`)
        }
        state.trusted.ownerUserIDs = state.trusted.ownerUserIDs.filter((item) => item !== userID)
      }
      await SynergyLinkStore.saveState(state)
      return {
        agents: state.trusted.agentIDs,
        users: state.trusted.ownerUserIDs,
      }
    })
  }

  export async function listRequests(): Promise<AvailabilityResult<{ requests: SynergyLinkPendingRequest[] }>> {
    return await onlineOnlyAvailability({ action: "requests.list" }, async () => {
      const state = await SynergyLinkStore.loadState()
      return { requests: state.pendingRequests }
    })
  }

  export async function showRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: SynergyLinkPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.show", requestID }, async () => {
      const state = await SynergyLinkStore.loadState()
      const request = state.pendingRequests.find((item) => item.id === requestID)
      if (!request) {
        throw new Error(`Unknown request: ${requestID}`)
      }
      return { request }
    })
  }

  export async function approveRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: SynergyLinkPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.approve", requestID }, async () => {
      return await decideRequestOffline(requestID, "approved")
    })
  }

  export async function denyRequest(
    requestID: string,
  ): Promise<AvailabilityResult<{ request: SynergyLinkPendingRequest }>> {
    return await onlineOnlyAvailability({ action: "requests.deny", requestID }, async () => {
      return await decideRequestOffline(requestID, "denied")
    })
  }

  export async function getLabel() {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "label.get" })
    }
    const state = await SynergyLinkStore.loadState()
    return {
      label: state.label ?? null,
    }
  }

  export async function setLabel(label: string | null) {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "label.set", label })
    }
    const state = await SynergyLinkStore.loadState()
    state.label = label ?? undefined
    await SynergyLinkStore.saveState(state)
    return {
      label: state.label ?? null,
    }
  }
}

async function onlineOnly<T>(request: { action: string; [key: string]: unknown }, reason: string): Promise<T> {
  if (!(await SynergyLinkControlClient.isAvailable())) {
    throw new Error(reason)
  }
  return await SynergyLinkControlClient.request<T>(request as never)
}

async function onlineOnlyAvailability<T>(
  request: { action: string; [key: string]: unknown },
  offline: () => Promise<T>,
): Promise<AvailabilityResult<T>> {
  if (await SynergyLinkControlClient.isAvailable()) {
    try {
      return supported(await SynergyLinkControlClient.request<T>(request as never))
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
  const state = await SynergyLinkStore.loadState()
  const request = state.pendingRequests.find((item) => item.id === requestID)
  if (!request) {
    throw new Error(`Unknown request: ${requestID}`)
  }
  request.status = status
  request.updatedAt = Date.now()
  request.decidedAt = request.updatedAt
  await SynergyLinkStore.saveState(state)
  return { request }
}

async function loadSnapshot() {
  const [state, service, authInfo] = await Promise.all([
    SynergyLinkStore.loadState(),
    SynergyLinkService.status(),
    SynergyLinkHolosAuth.inspect(),
  ])

  return {
    auth: sanitizeAuth(authInfo.auth, authInfo.source, {
      hiddenReason: state.runtimeMode === "managed" ? "managed" : null,
    }),
    mode: state.runtimeMode,
    ownership: SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry),
    state: sanitizeState(state),
    host: {
      linkID: state.linkID ?? null,
      hostSessionID: state.hostSessionID ?? null,
      label: state.label ?? null,
    },
    service,
  }
}

function sanitizeAuth(
  auth: { agentID: string; agentSecret: string } | undefined,
  source: SynergyLinkHolosAuthSource | null,
  options?: { hiddenReason?: SynergyLinkHiddenReason | null },
) {
  return auth
    ? {
        loggedIn: true,
        agentID: SynergyLinkDisplay.identifier(auth.agentID, {
          hiddenReason: options?.hiddenReason,
        }),
        source,
        hiddenReason: options?.hiddenReason ?? null,
      }
    : {
        loggedIn: false,
        agentID: null,
        source: null,
        hiddenReason: null,
      }
}

function sanitizeState(state: SynergyLinkState) {
  return {
    runtimeMode: state.runtimeMode,
    ownerRegistry: SynergyLinkOwnerRegistry.snapshot(state.ownerRegistry),
    collaborationEnabled: state.collaborationEnabled,
    approvalMode: state.approvalMode,
    trusted: {
      agentIDs: state.trusted.agentIDs,
      ownerUserIDs: state.trusted.ownerUserIDs,
    },
    pendingRequests: state.pendingRequests,
    blockedAgentIDs: state.blockedAgentIDs,
    linkID: state.linkID ?? null,
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
