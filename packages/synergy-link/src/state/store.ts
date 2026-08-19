import os from "node:os"
import path from "node:path"
import process from "node:process"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { SynergyLinkOwnerRegistry, type SynergyLinkOwnerRegistryState } from "../owner-registry"

export type SynergyLinkApprovalMode = "auto" | "manual" | "trusted-only"
export type SynergyLinkPendingRequestStatus = "pending" | "approved" | "denied"
export type SynergyLinkConnectionStatus = "disconnected" | "connecting" | "connected"
export type SynergyLinkRuntimeMode = "managed" | "standalone"
export type SynergyLinkServiceDesiredState = "running" | "stopped"
export type SynergyLinkServiceRuntimeStatus = "starting" | "running" | "stopping" | "stopped"

export interface SynergyLinkAuthState {
  agentID: string
  agentSecret: string
}

export interface SynergyLinkCurrentSessionState {
  sessionID: string
  remoteAgentID: string
  remoteOwnerUserID: number
  createdAt: number
  lastSeenAt: number
  label?: string
}

export interface SynergyLinkPendingRequest {
  id: string
  callerAgentID: string
  callerOwnerUserID: number
  label?: string
  status: SynergyLinkPendingRequestStatus
  requestedAt: number
  updatedAt: number
  decidedAt?: number
  consumedAt?: number
  requestCount: number
}

export interface SynergyLinkTrustedIdentityState {
  agentIDs: string[]
  ownerUserIDs: number[]
}

export interface SynergyLinkServiceState {
  desiredState: SynergyLinkServiceDesiredState
  runtimeStatus: SynergyLinkServiceRuntimeStatus
  pid?: number
  printLogs: boolean
  startedAt?: number
  stoppedAt?: number
  lastExitAt?: number
}

export interface SynergyLinkLogState {
  filePath: string
}

export interface SynergyLinkState {
  linkID?: string
  hostSessionID?: string
  label?: string
  runtimeMode: SynergyLinkRuntimeMode
  ownerRegistry: SynergyLinkOwnerRegistryState
  collaborationEnabled: boolean
  approvalMode: SynergyLinkApprovalMode
  trusted: SynergyLinkTrustedIdentityState
  pendingRequests: SynergyLinkPendingRequest[]
  blockedAgentIDs: string[]
  connectionStatus: SynergyLinkConnectionStatus
  sessionIdleTimeoutMs: number
  currentSession?: SynergyLinkCurrentSessionState
  service: SynergyLinkServiceState
  logs: SynergyLinkLogState
}

const DEFAULT_STATE: SynergyLinkState = {
  runtimeMode: "standalone",
  // Literal default, not SynergyLinkOwnerRegistry.defaultRegistry(): calling a
  // namespace member at module top level reads an uninitialized binding when
  // owner-registry.ts loads first (it imports SynergyLinkStore, forming a
  // cycle), which crashed the package test suite on CI.
  ownerRegistry: { local: { ownerIDs: [] } },
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

let saveQueue: Promise<void> = Promise.resolve()

export namespace SynergyLinkStore {
  export function root(): string {
    return process.env.SYNERGY_LINK_HOME || path.join(os.homedir(), ".synergy-link")
  }

  export function statePath(): string {
    return statePathForRoot(root())
  }

  export function migrationLogPath(): string {
    return migrationLogPathForRoot(root())
  }

  export function ownerRegistryPath(): string {
    return ownerRegistryPathForRoot(root())
  }

  export function logsPath(): string {
    return logsPathForRoot(root())
  }

  export function controlSocketPath(): string {
    return controlSocketPathForRoot(root())
  }

  export async function ensureRoot(rootPath = root()): Promise<void> {
    const logsDirectory = path.dirname(logsPathForRoot(rootPath))
    await mkdir(rootPath, { recursive: true, mode: 0o700 })
    await mkdir(logsDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") {
      await Promise.all([chmod(rootPath, 0o700), chmod(logsDirectory, 0o700)])
    }
  }

  export async function loadState(): Promise<SynergyLinkState> {
    const rootPath = root()
    const filepath = statePathForRoot(rootPath)
    let raw: string
    try {
      raw = await readFile(filepath, "utf8")
    } catch (error) {
      if (isEnoent(error)) return hydrateState(undefined, rootPath)
      throw error
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isPartialState(parsed)) throw new Error("State root must be a JSON object.")
      return hydrateState(parsed, rootPath)
    } catch (error) {
      throw new Error(`Failed to parse Synergy Link state at ${filepath}: ${errorMessage(error)}`, { cause: error })
    }
  }

  export async function saveState(state: SynergyLinkState): Promise<void> {
    const rootPath = root()
    const snapshot = JSON.stringify(hydrateState(structuredClone(state), rootPath), null, 2) + "\n"
    const write = saveQueue.then(() => writeRootFile(rootPath, statePathForRoot(rootPath), snapshot))
    saveQueue = write.catch(() => undefined)
    await write
  }

  export async function loadMigrationLog(): Promise<Record<string, number>> {
    const rootPath = root()
    try {
      const parsed = JSON.parse(await readFile(migrationLogPathForRoot(rootPath), "utf8")) as Record<string, unknown>
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
    const rootPath = root()
    await writeRootFile(rootPath, migrationLogPathForRoot(rootPath), JSON.stringify(log, null, 2) + "\n")
  }

  export function hydrateStateForMigration(parsed: unknown): SynergyLinkState {
    return hydrateState(isPartialState(parsed) ? parsed : undefined)
  }
}

async function writeRootFile(rootPath: string, filepath: string, content: string): Promise<void> {
  await SynergyLinkStore.ensureRoot(rootPath)
  const temporaryPath = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeTemporaryFile()
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (!isEnoent(error)) throw error
    await SynergyLinkStore.ensureRoot(rootPath)
    await writeTemporaryFile()
  }

  async function writeTemporaryFile() {
    await writeFile(temporaryPath, content, { mode: 0o600 })
    await rename(temporaryPath, filepath)
    if (process.platform !== "win32") await chmod(filepath, 0o600)
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function statePathForRoot(rootPath: string): string {
  return path.join(rootPath, "state.json")
}

function migrationLogPathForRoot(rootPath: string): string {
  return path.join(rootPath, "migrations.json")
}

function ownerRegistryPathForRoot(rootPath: string): string {
  return path.join(rootPath, "owner.json")
}

function logsPathForRoot(rootPath: string): string {
  return path.join(rootPath, "logs", "runtime.log")
}

function controlSocketPathForRoot(rootPath: string): string {
  return path.join(rootPath, "control.sock")
}

function hydrateState(
  parsed: Partial<SynergyLinkState> | undefined,
  rootPath = SynergyLinkStore.root(),
): SynergyLinkState {
  return {
    linkID: parsed?.linkID,
    hostSessionID: parsed?.hostSessionID,
    label: parsed?.label,
    runtimeMode: parseRuntimeMode(parsed?.runtimeMode),
    ownerRegistry: SynergyLinkOwnerRegistry.hydrate(parsed?.ownerRegistry),
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
      filePath: parsed?.logs?.filePath || DEFAULT_STATE.logs.filePath || logsPathForRoot(rootPath),
    },
  }
}

function hydrateCurrentSession(
  input: SynergyLinkState["currentSession"] | undefined,
): SynergyLinkState["currentSession"] | undefined {
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

function hydratePendingRequests(input: SynergyLinkState["pendingRequests"] | undefined): SynergyLinkPendingRequest[] {
  if (!Array.isArray(input)) return []
  const requests: SynergyLinkPendingRequest[] = []
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
      requestCount: typeof item.requestCount === "number" ? item.requestCount : 1,
    })
  }
  return requests
}

function uniqueStrings(input: unknown): string[] {
  return Array.isArray(input) ? [...new Set(input.filter((item): item is string => typeof item === "string"))] : []
}

function uniqueNumbers(input: unknown): number[] {
  return Array.isArray(input) ? [...new Set(input.filter((item): item is number => typeof item === "number"))] : []
}

function parseApprovalMode(input: unknown): SynergyLinkApprovalMode {
  return input === "auto" || input === "trusted-only" || input === "manual" ? input : DEFAULT_STATE.approvalMode
}

function parsePendingRequestStatus(input: unknown): SynergyLinkPendingRequestStatus {
  return input === "approved" || input === "denied" || input === "pending" ? input : "pending"
}

function parseConnectionStatus(input: unknown): SynergyLinkConnectionStatus {
  return input === "connecting" || input === "connected" || input === "disconnected" ? input : "disconnected"
}

function parseRuntimeMode(input: unknown): SynergyLinkRuntimeMode {
  return input === "managed" || input === "standalone" ? input : DEFAULT_STATE.runtimeMode
}

function parseServiceDesiredState(input: unknown): SynergyLinkServiceDesiredState {
  return input === "running" || input === "stopped" ? input : DEFAULT_STATE.service.desiredState
}

function parseServiceRuntimeStatus(input: unknown): SynergyLinkServiceRuntimeStatus {
  return input === "starting" || input === "running" || input === "stopping" || input === "stopped"
    ? input
    : DEFAULT_STATE.service.runtimeStatus
}

function isPartialState(input: unknown): input is Partial<SynergyLinkState> {
  return typeof input === "object" && input !== null
}
