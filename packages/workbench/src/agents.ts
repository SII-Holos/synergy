import type { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { resolveAgentModelRole, type BuiltinAgentContext } from "@ericsanchezok/synergy-harness/agent/builtin-context"
import { createPerformanceAnalystAgent } from "./performance/prompt/builder"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"

export function createDomainAgents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const performanceAnalyst = createPerformanceAnalystAgent(ctx)
  return {
    [performanceAnalyst.name]: performanceAnalyst,
  }
}

export function registerWorkbenchAgents() {
  AgentBuiltins.register("workbench", createDomainAgents)
}
