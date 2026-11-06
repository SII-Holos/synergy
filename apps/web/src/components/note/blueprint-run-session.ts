import type { AgentSummary, NotePatchInput, SessionWorkspaceSelection } from "@ericsanchezok/synergy-sdk/client"

export type BlueprintRunMode = "current" | "new" | "worktree"
export type BlueprintExecutionControlProfile = "autonomous" | "full_access"

export type BlueprintExecutionAgentOption = {
  name: string
  description?: string
  available: boolean
}

export type BlueprintScopeSummary = {
  id: string
  local?: { directory: string; worktree: string; sandboxes: string[]; vcs?: "git" } | null
}

export type BlueprintLoopSummary = {
  id: string
  status?: string
  source?: string
}

export type BlueprintRunNoteSummary = {
  blueprint?: {
    activeLoopID?: string | null
    activeLoopSource?: string
    lastRunSource?: string
    runCount?: number
    lastRunAt?: number
  }
}

export function blueprintSessionWorkspaceSelection(mode: BlueprintRunMode): SessionWorkspaceSelection | undefined {
  return mode === "worktree" ? { mode: "create" } : undefined
}

export function blueprintExecutionControlProfile(configured?: string | null): BlueprintExecutionControlProfile {
  return configured === "full_access" ? "full_access" : "autonomous"
}

export function blueprintExecutionAgentOptions(
  agents: AgentSummary[],
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

export function canRunBlueprintInCurrentSession(input: {
  sessionID?: string
  blueprintScopeID?: string
  sessionScopeID?: string
}) {
  return !!input.sessionID && !!input.blueprintScopeID && input.blueprintScopeID === input.sessionScopeID
}

export function canCreateBlueprintWorktree(input: { scopeID?: string; scopes: BlueprintScopeSummary[] }) {
  return input.scopes.find((scope) => scope.id === input.scopeID)?.local?.vcs === "git"
}

export function isActiveBlueprintLoopStatus(status?: string | null) {
  return status === "armed" || status === "running" || status === "auditing"
}

export function blueprintLoopFeatureAvailable(loop: { source?: string }, hasFeature: (id: string) => boolean) {
  if (!hasFeature("blueprint")) return false
  if (!loop.source || loop.source === "user") return true
  if (loop.source === "lattice") return hasFeature("lattice")
  if (loop.source === "plugin") return hasFeature("plugin-host") && hasFeature("plugin-blueprint")
  return false
}

export function blueprintRunHistory(
  note: BlueprintRunNoteSummary & { time: { updated: number } },
  loops: Array<{ time: { updated: number } }>,
  hasFeature: (id: string) => boolean,
) {
  const metadata = note.blueprint
  const history = blueprintLoopFeatureAvailable({ source: metadata?.lastRunSource }, hasFeature) ? metadata : undefined
  return {
    count: history?.runCount ?? loops.length,
    updated: history?.lastRunAt ?? loops[0]?.time.updated ?? note.time.updated,
    activeLoopID: blueprintLoopFeatureAvailable({ source: metadata?.activeLoopSource }, hasFeature)
      ? metadata?.activeLoopID
      : undefined,
  }
}

export function activeBlueprintLoop<T extends BlueprintLoopSummary>(
  note: BlueprintRunNoteSummary,
  loops: T[],
  hasFeature: (id: string) => boolean = () => true,
): T | undefined {
  const active = loops.filter(
    (loop) => blueprintLoopFeatureAvailable(loop, hasFeature) && isActiveBlueprintLoopStatus(loop.status),
  )

  const activeLoopID = note.blueprint?.activeLoopID
  if (activeLoopID) {
    const referenced = active.find((loop) => loop.id === activeLoopID)
    if (referenced) return referenced
  }
  return active[0]
}
