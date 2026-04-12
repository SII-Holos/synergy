import { readFile, writeFile } from "node:fs/promises"
import { MetaSynergyStore } from "./state/store"

export interface MetaSynergyLocalOwnerRegistryState {
  ownerIDs: string[]
  activeOwnerID?: string
  leaseExpiresAt?: number
}

export interface MetaSynergyOwnerRegistryState {
  local: MetaSynergyLocalOwnerRegistryState
}

const DEFAULT_REGISTRY: MetaSynergyOwnerRegistryState = {
  local: {
    ownerIDs: [],
  },
}

export namespace MetaSynergyOwnerRegistry {
  export function hydrate(input: unknown): MetaSynergyOwnerRegistryState {
    const parsed = isRecord(input) ? input : undefined
    if (isLegacySynergyOwnerRecord(parsed)) {
      const ownerID = parsed.agentId ? `synergy:${parsed.agentId}` : parsed.owner
      return {
        local: {
          ownerIDs: [ownerID],
          activeOwnerID: ownerID,
        },
      }
    }

    const local = isRecord(parsed?.local) ? parsed.local : undefined
    const ownerIDs = uniqueStrings(Array.isArray(local?.ownerIDs) ? local.ownerIDs : undefined)
    const activeOwnerID =
      typeof local?.activeOwnerID === "string" && local.activeOwnerID.length > 0 ? local.activeOwnerID : undefined
    const leaseExpiresAt =
      typeof local?.leaseExpiresAt === "number" && Number.isFinite(local.leaseExpiresAt)
        ? local.leaseExpiresAt
        : undefined

    if (activeOwnerID && !ownerIDs.includes(activeOwnerID)) {
      ownerIDs.unshift(activeOwnerID)
    }

    return {
      local: {
        ownerIDs,
        activeOwnerID,
        leaseExpiresAt,
      },
    }
  }

  export function declareLocalOwner(
    registry: MetaSynergyOwnerRegistryState,
    ownerID: string,
    options?: { leaseExpiresAt?: number },
  ) {
    const normalizedOwnerID = normalizeOwnerID(ownerID)
    if (!registry.local.ownerIDs.includes(normalizedOwnerID)) {
      registry.local.ownerIDs.unshift(normalizedOwnerID)
    }
    registry.local.activeOwnerID = normalizedOwnerID
    registry.local.leaseExpiresAt = normalizeLeaseExpiresAt(options?.leaseExpiresAt)
    return snapshot(registry)
  }

  export function releaseLocalOwner(registry: MetaSynergyOwnerRegistryState, ownerID?: string) {
    const normalizedOwnerID = ownerID ? normalizeOwnerID(ownerID) : undefined
    if (!normalizedOwnerID || registry.local.activeOwnerID === normalizedOwnerID) {
      registry.local.activeOwnerID = undefined
      registry.local.leaseExpiresAt = undefined
    }
    return snapshot(registry)
  }

  export function hasActiveLocalOwner(registry: MetaSynergyOwnerRegistryState, now = Date.now()) {
    const hydrated = hydrate(registry)
    if (!hydrated.local.activeOwnerID) return false
    if (hydrated.local.leaseExpiresAt !== undefined && hydrated.local.leaseExpiresAt <= now) {
      return false
    }
    return true
  }

  export function activeOwnerExpired(registry: MetaSynergyOwnerRegistryState, now = Date.now()) {
    const hydrated = hydrate(registry)
    return (
      hydrated.local.activeOwnerID !== undefined &&
      hydrated.local.leaseExpiresAt !== undefined &&
      hydrated.local.leaseExpiresAt <= now
    )
  }

  export function snapshot(registry: MetaSynergyOwnerRegistryState) {
    const hydrated = hydrate(registry)
    return {
      local: {
        ownerIDs: hydrated.local.ownerIDs,
        activeOwnerID: hydrated.local.activeOwnerID ?? null,
        leaseExpiresAt: hydrated.local.leaseExpiresAt ?? null,
        owned: hasActiveLocalOwner(hydrated),
      },
    }
  }

  export function defaultRegistry() {
    return hydrate(DEFAULT_REGISTRY)
  }

  export async function loadFile() {
    try {
      const parsed = JSON.parse(await readFile(MetaSynergyStore.ownerRegistryPath(), "utf8")) as unknown
      return hydrate(parsed)
    } catch {
      return defaultRegistry()
    }
  }

  export async function saveFile(registry: MetaSynergyOwnerRegistryState) {
    await MetaSynergyStore.ensureRoot()
    await writeFile(MetaSynergyStore.ownerRegistryPath(), JSON.stringify(snapshot(registry), null, 2) + "\n")
  }
}

function normalizeOwnerID(ownerID: string) {
  const normalized = ownerID.trim()
  if (!normalized) {
    throw new Error("Owner ID is required.")
  }
  return normalized
}

function normalizeLeaseExpiresAt(value: number | undefined) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) {
    throw new Error("Lease expiration must be a finite timestamp.")
  }
  return value
}

function uniqueStrings(values: unknown[] | undefined): string[] {
  return [
    ...new Set(
      values?.filter((value): value is string => typeof value === "string" && value.length > 0) ??
        DEFAULT_REGISTRY.local.ownerIDs,
    ),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLegacySynergyOwnerRecord(value: Record<string, unknown> | undefined): value is {
  owner: string
  agentId?: string
  version?: number
} {
  return typeof value?.owner === "string" && (value.version === undefined || typeof value.version === "number")
}
