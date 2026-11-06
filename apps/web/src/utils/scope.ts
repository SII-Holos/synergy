import { getFilename } from "@ericsanchezok/synergy-util/path"

export const HOME_SCOPE_KEY = "home"

export function isHomeScope(scopeKey: string | undefined) {
  return scopeKey === HOME_SCOPE_KEY
}

export type ProjectScopeCandidate = {
  id: string
  name?: string
  local?: { directory: string; worktree: string; sandboxes: string[]; vcs?: "git" } | null
}

export function getScopeLabel(scope?: ProjectScopeCandidate, fallbackScopeKey?: string) {
  if (isHomeScope(scope?.id ?? fallbackScopeKey)) return "Home"
  return scope?.name || getFilename(scope?.local?.worktree ?? "") || "Project"
}

export function resolveProjectScope(
  scopeID: string | undefined,
  activeScope: ProjectScopeCandidate | undefined,
  scopes: ReadonlyArray<ProjectScopeCandidate>,
): ProjectScopeCandidate | undefined {
  if (!scopeID || isHomeScope(scopeID)) return undefined
  return scopes.find((scope) => scope.id === scopeID) ?? (activeScope?.id === scopeID ? activeScope : undefined)
}
