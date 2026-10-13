import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { createLightLoopReviewerAgent, buildLightLoopReviewerPrompt } from "./prompts/lightloop-reviewer/builder"
export function registerAgents() {
  AgentBuiltins.register("light-loop", (ctx) => {
    const agent = createLightLoopReviewerAgent(ctx)
    return { [agent.name]: agent }
  })
  AgentBuiltins.registerPrompt("light-loop", "lightloop-reviewer", (agents) =>
    buildLightLoopReviewerPrompt(agents.map((agent) => ({ ...agent, description: agent.description ?? "" }))),
  )
}
