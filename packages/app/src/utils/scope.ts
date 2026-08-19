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
 * Resolve the project scope behind a route directory. The active scope (when
 * ready) is authoritative; otherwise match a known scope by its worktree or by
 * a sandbox directory so sub-directory routes still name their parent project.
 * Returns undefined for home or unknown directories.
 */
export function resolveProjectScope(
  directory: string | undefined,
  activeScope: ProjectScopeCandidate | undefined,
  scopes: ReadonlyArray<ProjectScopeCandidate>,
): ProjectScopeCandidate | undefined {
  if (!directory || isHomeScope(directory)) return undefined
  if (activeScope?.worktree) return activeScope
  return scopes.find((scope) => scope.worktree === directory || scope.sandboxes?.includes(directory))
}
