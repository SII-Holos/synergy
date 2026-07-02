import type { Session, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"

export type BlueprintRunMode = "current" | "new" | "worktree"
export type BlueprintExecutionControlProfile = "autonomous" | "full_access"

export type BlueprintScopeSummary = {
  id: string
  worktree?: string
  sandboxes?: string[]
  vcs?: string
}

export type BlueprintLoopSummary = {
  id: string
  status?: string
}

export type BlueprintRunNoteSummary = {
  blueprint?: {
    activeLoopID?: string | null
  }
}

function normalizeDirectory(input?: string) {
  return (input ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

export function blueprintSessionWorkspaceSelection(mode: BlueprintRunMode): SessionWorkspaceSelection {
  return mode === "worktree" ? { mode: "create" } : { mode: "current" }
}

export function blueprintExecutionControlProfile(configured?: string | null): BlueprintExecutionControlProfile {
  return configured === "full_access" ? "full_access" : "autonomous"
}

export function blueprintSessionRouteDirectory(session: Pick<Session, "scope">, fallback: string) {
  return session.scope.worktree ?? session.scope.directory ?? fallback
}

export function blueprintScopeIDForDirectory(directory: string | undefined, scopes: BlueprintScopeSummary[]) {
  if (!directory) return ""
  if (directory === "home") return "home"

  const target = normalizeDirectory(directory)
  const scope = scopes.find((item) => {
    if (normalizeDirectory(item.worktree) === target) return true
    return (item.sandboxes ?? []).some((sandbox) => normalizeDirectory(sandbox) === target)
  })
  return scope?.id ?? ""
}

export function canRunBlueprintInCurrentSession(input: {
  sessionID?: string
  blueprintDirectory?: string
  routeDirectory?: string
  scopes: BlueprintScopeSummary[]
}) {
  if (!input.sessionID) return false
  const blueprintScopeID = blueprintScopeIDForDirectory(input.blueprintDirectory, input.scopes)
  const routeScopeID = blueprintScopeIDForDirectory(input.routeDirectory, input.scopes)
  return !!blueprintScopeID && blueprintScopeID === routeScopeID
}

export function canCreateBlueprintWorktree(input: { blueprintDirectory?: string; scopes: BlueprintScopeSummary[] }) {
  if (!input.blueprintDirectory || input.blueprintDirectory === "home") return false
  const scopeID = blueprintScopeIDForDirectory(input.blueprintDirectory, input.scopes)
  const scope = input.scopes.find((item) => item.id === scopeID)
  return scope?.vcs === "git"
}

export function isActiveBlueprintLoopStatus(status?: string | null) {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

export function activeBlueprintLoop<T extends BlueprintLoopSummary>(
  note: BlueprintRunNoteSummary,
  loops: T[],
): T | BlueprintLoopSummary | undefined {
  const active = loops.find((loop) => isActiveBlueprintLoopStatus(loop.status))
  if (active) return active

  const activeLoopID = note.blueprint?.activeLoopID
  if (!activeLoopID) return undefined
  const referenced = loops.find((loop) => loop.id === activeLoopID)
  if (referenced && !isActiveBlueprintLoopStatus(referenced.status)) return undefined
  return referenced ?? { id: activeLoopID, status: "running" }
}
