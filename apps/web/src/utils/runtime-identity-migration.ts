import { z } from "zod"
import { spaceKey } from "../context/space-state"
import { Persist, workspaceEntryOwner } from "./persist"

const Binding = z.strictObject({ version: z.literal(1), runtimeID: z.uuid(), complete: z.boolean() })
const CacheOwner = z.union([
  z.tuple([z.string(), z.string()]),
  z.tuple([z.string(), z.string(), z.string().nullable(), z.number().int().positive().nullable()]),
])
const PluginPreferences = z.object({ version: z.literal(1), servers: z.record(z.string(), z.string()) }).passthrough()

export function migrateRuntimeIdentity(
  input: { connection: string; runtimeID: string; legacyDefault?: boolean },
  storage = localStorage,
) {
  const key = spaceKey({ kind: "personal", localRuntimeID: input.runtimeID })
  const source = `${Persist.connection(input.connection, "").storage}:`
  const destination = `${Persist.connection(key, "").storage}:`
  const bindingKey = source + "identity-binding"
  const stored = storage.getItem(bindingKey)
  const binding = stored
    ? Binding.parse(JSON.parse(stored))
    : { version: 1 as const, runtimeID: input.runtimeID, complete: false }
  if (binding.runtimeID !== input.runtimeID) return { key, adopted: false, legacyDefault: false }
  if (binding.complete) {
    const legacyDefault = input.legacyDefault ? migrateGlobalPreferences(input.runtimeID, key, storage) : false
    return { key, adopted: true, legacyDefault }
  }
  const claim = JSON.stringify(binding)
  if (stored === null) storage.setItem(bindingKey, claim)
  const ensureOwner = () => {
    if (storage.getItem(bindingKey) !== claim) throw new Error("Runtime cache ownership changed")
  }
  const entries = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  for (const previous of entries) {
    if (previous === null) continue
    if (previous === bindingKey) continue
    let target: string | undefined
    if (previous.startsWith(source)) target = destination + previous.slice(source.length)
    else {
      const owner = workspaceEntryOwner(previous)
      if (!owner) continue
      let parsed: z.infer<typeof CacheOwner>
      try {
        parsed = CacheOwner.parse(JSON.parse(owner))
      } catch {
        continue
      }
      if (parsed[0] !== input.connection) continue
      const prefix = `${Persist.workspace(owner, "").storage}:`
      const next = `${Persist.workspace(JSON.stringify([key, ...parsed.slice(1)]), "").storage}:`
      target = next + previous.slice(prefix.length)
    }
    ensureOwner()
    const value = storage.getItem(previous)
    if (value === null) continue
    if (storage.getItem(target) === null) storage.setItem(target, value)
    ensureOwner()
    if (storage.getItem(target) === value && storage.getItem(previous) === value) storage.removeItem(previous)
  }
  for (const kind of ["shell", "skin"]) {
    const target = Persist.global(`plugin-${kind}s`)
    const name = `${target.storage}:${target.key}`
    const raw = storage.getItem(name)
    if (!raw) continue
    let preferences: z.infer<typeof PluginPreferences>
    try {
      preferences = PluginPreferences.parse(JSON.parse(raw))
    } catch {
      continue
    }
    if (!preferences.servers[input.connection] || preferences.servers[key]) continue
    ensureOwner()
    preferences.servers[key] = preferences.servers[input.connection]!
    storage.setItem(name, JSON.stringify(preferences))
  }
  const legacyDefault = input.legacyDefault ? migrateGlobalPreferences(input.runtimeID, key, storage) : false
  ensureOwner()
  storage.setItem(bindingKey, JSON.stringify({ ...binding, complete: true }))
  return { key, adopted: true, legacyDefault }
}

function migrateGlobalPreferences(runtimeID: string, owner: string, storage: Storage) {
  const target = Persist.global("personal-cache-binding")
  const bindingKey = `${target.storage}:${target.key}`
  const stored = storage.getItem(bindingKey)
  const binding = stored ? Binding.parse(JSON.parse(stored)) : { version: 1 as const, runtimeID, complete: false }
  if (binding.runtimeID !== runtimeID) return false
  if (binding.complete) return true
  const claim = JSON.stringify(binding)
  if (stored === null) storage.setItem(bindingKey, claim)
  const ensureOwner = () => {
    if (storage.getItem(bindingKey) !== claim) throw new Error("Personal cache ownership changed")
  }
  for (const key of ["model", "prompt-history", "prompt-history-shell", "kanban", "auth"]) {
    const source = Persist.global(key)
    const destination = Persist.connection(owner, key)
    const next = `${destination.storage}:${destination.key}`
    for (const previous of [`${source.storage}:${source.key}`, `${key}.v1`]) {
      ensureOwner()
      const value = storage.getItem(previous)
      if (value === null) continue
      if (storage.getItem(next) === null) storage.setItem(next, value)
      ensureOwner()
      if (storage.getItem(next) === value && storage.getItem(previous) === value) storage.removeItem(previous)
    }
  }
  ensureOwner()
  storage.setItem(bindingKey, JSON.stringify({ ...binding, complete: true }))
  return true
}
