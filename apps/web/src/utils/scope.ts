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
  id?: string
  worktree: string
  name?: string
  sandboxes?: string[]
}

/**
 * Normalize a directory key so route directories and scope metadata match
 * across separator and trailing-slash drift, folding case only for Windows paths.
 */
function normalizeDirectoryKey(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

function matchesDirectory(candidate: ProjectScopeCandidate, target: string) {
  return (
    normalizeDirectoryKey(candidate.worktree) === target ||
    !!candidate.sandboxes?.some((sandbox) => normalizeDirectoryKey(sandbox) === target)
  )
}

/**
 * Resolve the project scope behind a route directory. Exact worktree
 * ownership wins first: a directory that is a known project's worktree
 * belongs to that project even when another project registered the same
 * directory as one of its additional folders (sandboxes). Otherwise a
 * sandbox mapping names its parent project (opening a registered
 * sub-directory routes to the parent), and finally the active scope is
 * trusted only when it actually covers the route directory — after list
 * matching, because a bootstrap-resolved sub-directory scope must not
 * shadow its persisted parent project.
 * Returns undefined for home or unknown directories.
 */
export function resolveProjectScope(
  directory: string | undefined,
  activeScope: ProjectScopeCandidate | undefined,
  scopes: ReadonlyArray<ProjectScopeCandidate>,
): ProjectScopeCandidate | undefined {
  if (!directory || isHomeScope(directory)) return undefined
  const target = normalizeDirectoryKey(directory)
  const byWorktree = scopes.find((scope) => normalizeDirectoryKey(scope.worktree) === target)
  if (byWorktree) return byWorktree
  const bySandbox = scopes.find((scope) =>
    scope.sandboxes?.some((sandbox) => normalizeDirectoryKey(sandbox) === target),
  )
  if (bySandbox) return bySandbox
  if (activeScope && matchesDirectory(activeScope, target)) return activeScope
  return undefined
}
