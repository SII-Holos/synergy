import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export function selectableDefaultAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => agent.mode === "primary" && !agent.hidden)
}

export function hasSelectedDefaultAgent(agents: Agent[], defaultAgent: string): boolean {
  return selectableDefaultAgents(agents).some((agent) => agent.name === defaultAgent)
}
