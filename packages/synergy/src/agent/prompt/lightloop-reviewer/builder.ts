import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import { buildAgentTable } from "../agent-table"
import type { AgentInfo } from "../types"
import PROMPT_BASE from "./base.txt"

export function buildLightLoopReviewerPrompt(agents: AgentInfo[]): string {
  const caller = agents.find((agent) => agent.name === "lightloop-reviewer") ?? {
    name: "lightloop-reviewer",
    delegationGroups: ["supervisor"],
  }
  const agentTable = buildAgentTable(agents, caller)
  return PROMPT_BASE.replace("{AGENT_TABLE}", agentTable)
}

export function createLightLoopReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "lightloop-reviewer",
    description:
      "Reviews LightLoop stop requests. Verifies the original task description against session trajectory, artifacts, and evidence, then approves completion or returns concrete remaining work. Does not edit files or audit Blueprint notes.",
    prompt: buildLightLoopReviewerPrompt([]),
    model: "thinking",
    permission: "lightLoopReviewer",
    hidden: true,
    visibleTo: ["lightloop-reviewer"],
    delegationGroups: ["supervisor"],
  })
}
