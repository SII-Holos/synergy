import { readFile, writeFile } from "node:fs/promises"
import { MetaSynergyStore } from "./state/store"

export interface MetaSynergyLocalOwnerRegistryState {
  ownerIDs: string[]
  activeOwnerID?: string
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

    if (activeOwnerID && !ownerIDs.includes(activeOwnerID)) {
      ownerIDs.unshift(activeOwnerID)
    }

    return {
      local: {
        ownerIDs,
        activeOwnerID,
      },
    }
  }

  export function declareLocalOwner(registry: MetaSynergyOwnerRegistryState, ownerID: string) {
    const normalizedOwnerID = normalizeOwnerID(ownerID)
    if (!registry.local.ownerIDs.includes(normalizedOwnerID)) {
      registry.local.ownerIDs.unshift(normalizedOwnerID)
    }
    registry.local.activeOwnerID = normalizedOwnerID
    return snapshot(registry)
  }

  export function snapshot(registry: MetaSynergyOwnerRegistryState) {
    const hydrated = hydrate(registry)
    return {
      local: {
        ownerIDs: hydrated.local.ownerIDs,
        activeOwnerID: hydrated.local.activeOwnerID ?? null,
        owned: hydrated.local.activeOwnerID !== undefined,
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
