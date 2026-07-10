import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import { buildAgentTable } from "../agent-table"
import type { AgentInfo } from "../types"
import PROMPT_BASE from "./base.txt"

export function buildSupervisorPrompt(agents: AgentInfo[]): string {
  const caller = agents.find((agent) => agent.name === "supervisor") ?? { name: "supervisor" }
  const agentTable = buildAgentTable(agents, caller)
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable)
}

export function createSupervisorAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "supervisor",
    description:
      "Internal BlueprintLoop audit agent. Verifies outcome completeness and either rejects the review with concrete findings or approves it.",
    prompt: buildSupervisorPrompt([]),
    model: "thinking",
    permission: "supervisor",
    hidden: true,
    visibleTo: ["supervisor"],
  })
}
