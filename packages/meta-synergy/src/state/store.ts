import os from "node:os"
import path from "node:path"
import process from "node:process"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { MetaSynergyOwnerRegistry, type MetaSynergyOwnerRegistryState } from "../owner-registry"

export type MetaSynergyApprovalMode = "auto" | "manual" | "trusted-only"
export type MetaSynergyPendingRequestStatus = "pending" | "approved" | "denied"
export type MetaSynergyConnectionStatus = "disconnected" | "connecting" | "connected"
export type MetaSynergyRuntimeMode = "managed" | "standalone"
export type MetaSynergyServiceDesiredState = "running" | "stopped"
export type MetaSynergyServiceRuntimeStatus = "starting" | "running" | "stopping" | "stopped"

export interface MetaSynergyAuthState {
  agentID: string
  agentSecret: string
}

export interface MetaSynergyCurrentSessionState {
  sessionID: string
  remoteAgentID: string
  remoteOwnerUserID: number
  createdAt: number
  lastSeenAt: number
  label?: string
}

export interface MetaSynergyPendingRequest {
  id: string
  callerAgentID: string
  callerOwnerUserID: number
  label?: string
  status: MetaSynergyPendingRequestStatus
  requestedAt: number
  updatedAt: number
  decidedAt?: number
  consumedAt?: number
  requestCount: number
}

export interface MetaSynergyTrustedIdentityState {
  agentIDs: string[]
  ownerUserIDs: number[]
}

export interface MetaSynergyServiceState {
  desiredState: MetaSynergyServiceDesiredState
  runtimeStatus: MetaSynergyServiceRuntimeStatus
  pid?: number
  printLogs: boolean
  startedAt?: number
  stoppedAt?: number
  lastExitAt?: number
}

export interface MetaSynergyLogState {
  filePath: string
}

export interface MetaSynergyState {
  envID?: string
  hostSessionID?: string
  label?: string
  runtimeMode: MetaSynergyRuntimeMode
  ownerRegistry: MetaSynergyOwnerRegistryState
  collaborationEnabled: boolean
  approvalMode: MetaSynergyApprovalMode
  trusted: MetaSynergyTrustedIdentityState
  pendingRequests: MetaSynergyPendingRequest[]
  blockedAgentIDs: string[]
  connectionStatus: MetaSynergyConnectionStatus
  sessionIdleTimeoutMs: number
  currentSession?: MetaSynergyCurrentSessionState
  service: MetaSynergyServiceState
  logs: MetaSynergyLogState
}

const DEFAULT_STATE: MetaSynergyState = {
  runtimeMode: "standalone",
  ownerRegistry: MetaSynergyOwnerRegistry.defaultRegistry(),
  collaborationEnabled: true,
  approvalMode: "manual",
  trusted: {
    agentIDs: [],
    ownerUserIDs: [],
  },
  pendingRequests: [],
  blockedAgentIDs: [],
  connectionStatus: "disconnected",
  sessionIdleTimeoutMs: 10 * 60 * 1000,
  service: {
    desiredState: "stopped",
    runtimeStatus: "stopped",
    printLogs: false,
  },
  logs: {
    filePath: "",
  },
}

export namespace MetaSynergyStore {
  export function root(): string {
    return process.env.META_SYNERGY_HOME || path.join(os.homedir(), ".meta-synergy")
  }

  export function legacyAuthPath(): string {
    return path.join(root(), "auth.json")
  }

  export function statePath(): string {
    return path.join(root(), "state.json")
  }

  export function migrationLogPath(): string {
    return path.join(root(), "migrations.json")
  }

  export function ownerRegistryPath(): string {
    return path.join(root(), "owner.json")
  }

  export function logsPath(): string {
    return path.join(root(), "logs", "runtime.log")
  }

  export function controlSocketPath(): string {
    return path.join(root(), "control.sock")
  }

  export async function ensureRoot(): Promise<void> {
    await mkdir(root(), { recursive: true })
    await mkdir(path.dirname(logsPath()), { recursive: true })
    await mkdir(path.dirname(controlSocketPath()), { recursive: true })
  }

  export async function loadLegacyAuth(): Promise<MetaSynergyAuthState | undefined> {
    try {
      return JSON.parse(await readFile(legacyAuthPath(), "utf8")) as MetaSynergyAuthState
    } catch {
      return undefined
    }
  }

  export async function saveLegacyAuth(auth: MetaSynergyAuthState): Promise<void> {
    await ensureRoot()
    await writeFile(legacyAuthPath(), JSON.stringify(auth, null, 2) + "\n")
  }

  export async function clearLegacyAuth(): Promise<void> {
    await unlink(legacyAuthPath()).catch(() => undefined)
  }

  export async function loadState(): Promise<MetaSynergyState> {
    try {
      const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<MetaSynergyState>
      return hydrateState(parsed)
    } catch {
      return hydrateState(undefined)
    }
  }

  export async function saveState(state: MetaSynergyState): Promise<void> {
    await ensureRoot()
    await writeFile(statePath(), JSON.stringify(hydrateState(state), null, 2) + "\n")
  }

  export async function loadMigrationLog(): Promise<Record<string, number>> {
    try {
      const parsed = JSON.parse(await readFile(migrationLogPath(), "utf8")) as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number",
        ),
      )
    } catch {
      return {}
    }
  }

  export async function saveMigrationLog(log: Record<string, number>): Promise<void> {
    await ensureRoot()
    await writeFile(migrationLogPath(), JSON.stringify(log, null, 2) + "\n")
  }

  export function hydrateStateForMigration(parsed: unknown): MetaSynergyState {
    return hydrateState(isPartialState(parsed) ? parsed : undefined)
  }
}

function hydrateState(parsed: Partial<MetaSynergyState> | undefined): MetaSynergyState {
  return {
    envID: parsed?.envID,
    hostSessionID: parsed?.hostSessionID,
    label: parsed?.label,
    runtimeMode: parseRuntimeMode(parsed?.runtimeMode),
    ownerRegistry: MetaSynergyOwnerRegistry.hydrate(parsed?.ownerRegistry),
    collaborationEnabled: parsed?.collaborationEnabled ?? DEFAULT_STATE.collaborationEnabled,
    approvalMode: parseApprovalMode(parsed?.approvalMode),
    trusted: {
      agentIDs: uniqueStrings(parsed?.trusted?.agentIDs),
      ownerUserIDs: uniqueNumbers(parsed?.trusted?.ownerUserIDs),
    },
    pendingRequests: hydratePendingRequests(parsed?.pendingRequests),
    blockedAgentIDs: uniqueStrings(parsed?.blockedAgentIDs),
    connectionStatus: parseConnectionStatus(parsed?.connectionStatus),
    sessionIdleTimeoutMs: Math.max(60_000, parsed?.sessionIdleTimeoutMs ?? DEFAULT_STATE.sessionIdleTimeoutMs),
    currentSession: hydrateCurrentSession(parsed?.currentSession),
    service: {
      desiredState: parseServiceDesiredState(parsed?.service?.desiredState),
      runtimeStatus: parseServiceRuntimeStatus(parsed?.service?.runtimeStatus),
      pid: typeof parsed?.service?.pid === "number" ? parsed.service.pid : undefined,
      printLogs: parsed?.service?.printLogs ?? DEFAULT_STATE.service.printLogs,
      startedAt: typeof parsed?.service?.startedAt === "number" ? parsed.service.startedAt : undefined,
      stoppedAt: typeof parsed?.service?.stoppedAt === "number" ? parsed.service.stoppedAt : undefined,
      lastExitAt: typeof parsed?.service?.lastExitAt === "number" ? parsed.service.lastExitAt : undefined,
    },
    logs: {
      filePath: parsed?.logs?.filePath || DEFAULT_STATE.logs.filePath || MetaSynergyStore.logsPath(),
    },
  }
}

function hydrateCurrentSession(
  input: MetaSynergyState["currentSession"] | undefined,
): MetaSynergyState["currentSession"] | undefined {
  if (!input) return undefined
  if (
    typeof input.sessionID !== "string" ||
    typeof input.remoteAgentID !== "string" ||
    typeof input.remoteOwnerUserID !== "number" ||
    typeof input.createdAt !== "number" ||
    typeof input.lastSeenAt !== "number"
  ) {
    return undefined
  }
  return {
    sessionID: input.sessionID,
    remoteAgentID: input.remoteAgentID,
    remoteOwnerUserID: input.remoteOwnerUserID,
    createdAt: input.createdAt,
    lastSeenAt: input.lastSeenAt,
    label: typeof input.label === "string" ? input.label : undefined,
  }
}

function hydratePendingRequests(input: MetaSynergyState["pendingRequests"] | undefined): MetaSynergyPendingRequest[] {
  if (!Array.isArray(input)) return []
  const requests: MetaSynergyPendingRequest[] = []
  for (const item of input) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.callerAgentID !== "string" ||
      typeof item.callerOwnerUserID !== "number" ||
      typeof item.requestedAt !== "number"
    ) {
      continue
    }
    requests.push({
      id: item.id,
      callerAgentID: item.callerAgentID,
      callerOwnerUserID: item.callerOwnerUserID,
      label: typeof item.label === "string" ? item.label : undefined,
      status: parsePendingRequestStatus(item.status),
      requestedAt: item.requestedAt,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : item.requestedAt,
      decidedAt: typeof item.decidedAt === "number" ? item.decidedAt : undefined,
      consumedAt: typeof item.consumedAt === "number" ? item.consumedAt : undefined,
      requestCount: Math.max(1, item.requestCount ?? 1),
    })
  }
  requests.sort((left, right) => right.updatedAt - left.updatedAt)
  return requests
}

function parseRuntimeMode(input: unknown): MetaSynergyRuntimeMode {
  return input === "managed" || input === "standalone" ? input : DEFAULT_STATE.runtimeMode
}

function parseApprovalMode(input: unknown): MetaSynergyApprovalMode {
  return input === "auto" || input === "trusted-only" || input === "manual" ? input : DEFAULT_STATE.approvalMode
}

function parsePendingRequestStatus(input: unknown): MetaSynergyPendingRequestStatus {
  return input === "approved" || input === "denied" || input === "pending" ? input : "pending"
}

function parseConnectionStatus(input: unknown): MetaSynergyConnectionStatus {
  return input === "connecting" || input === "connected" || input === "disconnected"
    ? input
    : DEFAULT_STATE.connectionStatus
}

function parseServiceDesiredState(input: unknown): MetaSynergyServiceDesiredState {
  return input === "running" || input === "stopped" ? input : DEFAULT_STATE.service.desiredState
}

function parseServiceRuntimeStatus(input: unknown): MetaSynergyServiceRuntimeStatus {
  return input === "starting" || input === "running" || input === "stopping" || input === "stopped"
    ? input
    : DEFAULT_STATE.service.runtimeStatus
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value): value is string => typeof value === "string" && value.length > 0))]
}

function uniqueNumbers(values: number[] | undefined): number[] {
  return [
    ...new Set((values ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value))),
  ]
}

function isPartialState(value: unknown): value is Partial<MetaSynergyState> {
  return typeof value === "object" && value !== null
}
