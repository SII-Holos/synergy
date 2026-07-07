import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import { buildAgentTable } from "../agent-table"
import type { AgentInfo } from "../types"
import PROMPT_BASE from "./base.txt"

export function buildSupervisorPrompt(agents: AgentInfo[]): string {
  const agentTable = buildAgentTable(agents, "supervisor")
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable)
}

export function createSupervisorAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "supervisor",
    description:
      "Internal BlueprintLoop audit agent. Verifies implementation completeness and either restarts the loop with concrete findings or marks it complete.",
    prompt: buildSupervisorPrompt([]),
    model: "thinking",
    permission: "supervisor",
    hidden: true,
    visibleTo: ["synergy", "synergy-max", "supervisor"],
  })
}
