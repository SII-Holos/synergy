import type { AgentInfo } from "./types"

/**
 * Agents a given primary can delegate work to.
 */
export function getDelegatableAgents(agents: AgentInfo[], primaryName = "synergy"): AgentInfo[] {
  return agents.filter(
    (agent) =>
      !agent.hidden &&
      agent.name !== primaryName &&
      (agent.mode === "subagent" || agent.mode === "all") &&
      (!agent.visibleTo || agent.visibleTo.includes(primaryName)),
  )
}

/**
 * Build the agent table showing available subagents.
 */
export function buildAgentTable(agents: AgentInfo[], primaryName = "synergy"): string {
  const available = getDelegatableAgents(agents, primaryName)

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

Choose the narrowest specialized subagent for the current workflow stage. Do not route substantial work to the primary \`${primaryName}\` agent when a subagent can own the stage.`
}
