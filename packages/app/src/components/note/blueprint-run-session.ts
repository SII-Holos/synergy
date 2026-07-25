import type { Agent, NotePatchInput, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"

export type BlueprintRunMode = "current" | "new" | "worktree"
export type BlueprintExecutionControlProfile = "autonomous" | "full_access"

export type BlueprintExecutionAgentOption = {
  name: string
  description?: string
  available: boolean
}

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

export function blueprintExecutionAgentOptions(
  agents: Agent[],
  selectedAgent?: string | null,
): BlueprintExecutionAgentOption[] {
  const visible = agents
    .filter((agent) => !agent.hidden)
    .map((agent) => ({
      name: agent.name,
      description: agent.description,
      available: true,
    }))
  const selected = selectedAgent?.trim()
  if (!selected || visible.some((agent) => agent.name === selected)) return visible
  return [{ name: selected, description: undefined, available: false }, ...visible]
}

export function blueprintExecutionAgentPatch(note: { version: number }, agentName: string): NotePatchInput {
  return {
    expectedVersion: note.version,
    blueprint: { defaultAgent: agentName },
  }
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
): T | undefined {
  const active = loops.filter((loop) => isActiveBlueprintLoopStatus(loop.status))

  const activeLoopID = note.blueprint?.activeLoopID
  if (activeLoopID) {
    const referenced = active.find((loop) => loop.id === activeLoopID)
    if (referenced) return referenced
  }
  return active[0]
}
