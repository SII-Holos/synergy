import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import { createSubagent } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import { buildAgentTable } from "@ericsanchezok/synergy-harness/agent/prompt/agent-table"
import type { AgentInfo } from "@ericsanchezok/synergy-harness/agent/prompt/types"
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
    permission: PermissionNext.fromConfig({
      "*": "deny",
      read: "allow",
      expand_tools: "allow",
      search_tools: "allow",
      bash: "allow",
      process: "allow",
      skill: "allow",
      webfetch: "allow",
      list: "allow",
      dagwrite: "allow",
      dagread: "allow",
      dagpatch: "allow",
      task: "allow",
      task_list: "allow",
      task_output: "allow",
      task_cancel: "allow",
      session_list: "allow",
      scope_list: "allow",
      session_read: "allow",
      session_search: "allow",
      light_loop_approve: "allow",
      light_loop_reject: "allow",
    }),
    hidden: true,
    visibleTo: ["lightloop-reviewer"],
    delegationGroups: ["supervisor"],
  })
}
