import { getFilename } from "@ericsanchezok/synergy-util/path"
import type { LocalScope } from "@/context/layout"

export const HOME_SCOPE_KEY = "home"

export function isHomeScope(scopeKey: string | undefined) {
  return scopeKey === HOME_SCOPE_KEY
}

export function getScopeLabel(scope?: Pick<LocalScope, "worktree" | "name">, fallbackScopeKey?: string) {
  const scopeKey = scope?.worktree || fallbackScopeKey || ""
  if (isHomeScope(scopeKey)) return "Home"
  return scope?.name || getFilename(scopeKey) || "Project"
}
