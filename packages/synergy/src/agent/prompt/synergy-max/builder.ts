import PROMPT_BASE from "./base.txt"
import { buildAgentTable } from "../agent-table"
import type { AgentInfo } from "../types"
import { buildSynergyMemorySection } from "../synergy/builder"

export function buildSynergyMaxPrompt(agents: AgentInfo[]): string {
  const agentTable = buildAgentTable(agents, "synergy-max")
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable).replace("{MEMORY_INTERACTION}", buildSynergyMemorySection())
}
