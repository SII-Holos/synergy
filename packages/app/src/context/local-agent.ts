export type AgentVisibility = {
  mode?: string
  hidden?: boolean
}

export function getVisiblePrimaryAgents<T extends AgentVisibility>(agents: readonly T[] | null | undefined) {
  if (!Array.isArray(agents)) return []
  return agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
}
