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

export type ProjectScopeCandidate = {
  worktree: string
  name?: string
  sandboxes?: string[]
}

/**
 * Resolve the project scope behind a route directory. A sandbox mapping is
 * authoritative: the bootstrap-resolved scope for a sub-directory route is the
 * sub-directory's own scope (server-side `Scope.fromDirectory` never maps a
 * sandbox back to its parent), so we match known scopes by sandbox directory
 * first. Otherwise trust the active scope only when it actually covers the
 * route directory, and finally fall back to an exact worktree match.
 * Returns undefined for home or unknown directories.
 */
export function resolveProjectScope(
  directory: string | undefined,
  activeScope: ProjectScopeCandidate | undefined,
  scopes: ReadonlyArray<ProjectScopeCandidate>,
): ProjectScopeCandidate | undefined {
  if (!directory || isHomeScope(directory)) return undefined
  const bySandbox = scopes.find((scope) => scope.sandboxes?.includes(directory))
  if (bySandbox) return bySandbox
  if (activeScope && (activeScope.worktree === directory || activeScope.sandboxes?.includes(directory))) {
    return activeScope
  }
  return scopes.find((scope) => scope.worktree === directory)
}
