import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import type { BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import { createSubagent } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import { buildAgentTable } from "@ericsanchezok/synergy-harness/agent/prompt/agent-table"
import type { AgentInfo } from "@ericsanchezok/synergy-harness/agent/prompt/types"
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
    permission: PermissionNext.fromConfig({
      "*": "deny",
      expand_tools: "allow",
      search_tools: "allow",
      bash: "allow",
      process: "allow",
      skill: "allow",
      webfetch: "allow",
      glob: "allow",
      list: "allow",
      view_file: "allow",
      scan_files: "allow",
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
      blueprint_loop_stop: "allow",
      blueprint_loop_approve: "allow",
      blueprint_loop_reject: "allow",
    }),
    hidden: true,
    visibleTo: ["supervisor"],
  })
}
