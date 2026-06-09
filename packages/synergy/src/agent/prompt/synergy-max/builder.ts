import PROMPT_BASE from "./base.txt"
import { buildAgentTable, buildSynergyMemorySection, type AgentInfo } from "../synergy/builder"

export function buildSynergyMaxPrompt(agents: AgentInfo[]): string {
  const agentTable = buildAgentTable(agents, "synergy-max")
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable).replace("{MEMORY_INTERACTION}", buildSynergyMemorySection())
}
