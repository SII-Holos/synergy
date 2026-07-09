import { AgentDelegation, type DelegationCaller } from "../delegation"
import type { AgentInfo } from "./types"

/**
 * Agents a given primary can delegate work to.
 */
export function getDelegatableAgents(agents: AgentInfo[], caller: string | DelegationCaller = "synergy"): AgentInfo[] {
  return agents.filter((agent) => AgentDelegation.canDelegateTo(agent, caller))
}

/**
 * Build the agent table showing available subagents.
 */
export function buildAgentTable(agents: AgentInfo[], caller: string | DelegationCaller = "synergy"): string {
  const callerName = typeof caller === "string" ? caller : caller.name
  const available = getDelegatableAgents(agents, caller)

  if (available.length === 0) {
    return `No specialized subagents are available. Handle only small direct tasks and ask the user to configure subagents for larger work.`
  }

  const rows = available.map((a) => {
    const desc = a.description || "General-purpose agent"
    return `| \`${a.name}\` | ${desc} |`
  })

  return `| Agent | Use Case |
|-------|----------|
${rows.join("\n")}

Choose the narrowest specialized subagent for the current workflow stage. Do not route substantial work to the primary \`${callerName}\` agent when a subagent can own the stage.`
}
