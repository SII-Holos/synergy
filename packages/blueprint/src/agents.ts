import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { createSupervisorAgent, buildSupervisorPrompt } from "./prompts/supervisor/builder"
export function registerAgents() {
  AgentBuiltins.register("blueprint", (ctx) => {
    const agent = createSupervisorAgent(ctx)
    return { [agent.name]: agent }
  })
  AgentBuiltins.registerPrompt("blueprint", "supervisor", (agents) =>
    buildSupervisorPrompt(agents.map((agent) => ({ ...agent, description: agent.description ?? "" }))),
  )
}
