import { makePersisted, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [Store<T>, SetStoreFunction<T>, InitType, Accessor<boolean>]

type PersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
}

const GLOBAL_STORAGE = "synergy.global.dat"

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function workspaceStorage(dir: string) {
  const head = dir.slice(0, 12) || "workspace"
  const sum = checksum(dir) ?? "0"
  return `synergy.workspace.${head}.${sum}.dat`
}

const quotaWarnedKeys = new Set<string>()

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  return {
    getItem: (key) => localStorage.getItem(base + key),
    setItem: (key, value) => localStorage.setItem(base + key, value),
    removeItem: (key) => localStorage.removeItem(base + key),
  }
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `workspace:${key}`, legacy }
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: workspaceStorage(dir), key: `session:${session}:${key}`, legacy }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
}

export function removePersisted(target: { storage?: string; key: string }) {
  if (!target.storage) {
    localStorage.removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const currentStorage = (() => {
    if (!config.storage) return localStorage
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = localStorage

  const storage: SyncStorage = {
    getItem: (key) => {
      const raw = currentStorage.getItem(key)
      if (raw !== null) {
        const parsed = parse(raw)
        if (parsed === undefined) return raw

        const migrated = config.migrate ? config.migrate(parsed) : parsed
        const merged = merge(defaults, migrated)
        const next = JSON.stringify(merged)
        if (raw !== next) currentStorage.setItem(key, next)
        return next
      }

      for (const legacyKey of legacy) {
        const legacyRaw = legacyStorage.getItem(legacyKey)
        if (legacyRaw === null) continue

        currentStorage.setItem(key, legacyRaw)
        legacyStorage.removeItem(legacyKey)

        const parsed = parse(legacyRaw)
        if (parsed === undefined) return legacyRaw

        const migrated = config.migrate ? config.migrate(parsed) : parsed
        const merged = merge(defaults, migrated)
        const next = JSON.stringify(merged)
        if (legacyRaw !== next) currentStorage.setItem(key, next)
        return next
      }

      return null
    },
    setItem: (key, value) => {
      try {
        currentStorage.setItem(key, value)
        quotaWarnedKeys.delete(key)
      } catch (e) {
        if (e instanceof DOMException && e.name === "QuotaExceededError") {
          if (!quotaWarnedKeys.has(key)) {
            quotaWarnedKeys.add(key)
            console.warn("[persist] localStorage quota exceeded, skipping persist for:", key)
          }
          return
        }
        throw e
      }
    },
    removeItem: (key) => {
      currentStorage.removeItem(key)
    },
  }

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      if (initValue instanceof Promise) await initValue
      return true
    },
    { initialValue: !isAsync },
  )

  return [state, setState, init, () => ready() === true]
}
