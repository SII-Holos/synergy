import { base64Encode, checksum } from "@ericsanchezok/synergy-util/encode"
import { Persist } from "./persist"

interface ScopeBinding {
  id: string
  local?: { directory: string; worktree: string; sandboxes: string[] } | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function migrateScopeState(input: { connection: string; scopes: ScopeBinding[]; includeHome: boolean }) {
  const prefixes = new Map<string, string>()
  const routes = new Map<string, string>()
  const scopes: ScopeBinding[] = input.includeHome ? [{ id: "home", local: null }, ...input.scopes] : input.scopes
  const bindings = new Map<string, ScopeBinding>()
  for (const scope of scopes) {
    if (scope.local) bindings.set(scope.local.directory, scope)
    else if (scope.id === "home") bindings.set("home", scope)
  }
  for (const scope of scopes) {
    for (const alias of scope.local ? [scope.local.worktree, ...scope.local.sandboxes] : []) {
      if (!bindings.has(alias)) bindings.set(alias, scope)
    }
  }
  for (const [directory, scope] of bindings) {
    const owner = Persist.scopeKey(input.connection, scope.id)
    const destination = Persist.workspace(owner, "").storage!
    routes.set(base64Encode(directory), base64Encode(scope.id))
    for (const alias of [directory, base64Encode(directory)]) {
      const prefix = `synergy.workspace.${alias.slice(0, 12) || "workspace"}.${checksum(alias) ?? "0"}.dat:`
      prefixes.set(prefix, `${destination}:`)
    }
  }
  for (const key of Object.keys(localStorage)) {
    const end = key.indexOf(".dat:")
    if (end === -1) continue
    const destination = prefixes.get(key.slice(0, end + 5))
    if (!destination) continue
    const value = localStorage.getItem(key)
    if (value === null) continue
    const target = `${destination}${key.slice(end + 5)}`
    if (localStorage.getItem(target) === null) localStorage.setItem(target, value)
    localStorage.removeItem(key)
  }
  if (!input.includeHome) return
  const layoutKey = Persist.connection(input.connection, "layout")
  const destination = `${layoutKey.storage}:${layoutKey.key}`
  const raw = localStorage.getItem("synergy.global.dat:layout")
  if (!raw || localStorage.getItem(destination) !== null) return
  let layout: unknown
  try {
    layout = JSON.parse(raw)
  } catch {
    return
  }
  if (!record(layout)) return
  for (const field of ["sessionView", "workbenchSurfaces"]) {
    const values = layout[field]
    if (!record(values)) continue
    const migrated: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      const [directory, ...rest] = key.split("/")
      const scopeID = routes.get(directory)
      if (scopeID) migrated[[scopeID, ...rest].join("/")] = value
    }
    layout[field] = migrated
  }
  localStorage.setItem(destination, JSON.stringify(layout))
}
