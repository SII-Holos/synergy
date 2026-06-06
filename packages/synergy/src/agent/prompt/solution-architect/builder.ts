import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildSolutionArchitectPrompt(): string {
  return PROMPT_BASE
}

export function createSolutionArchitectAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "solution-architect",
    description:
      "Designs implementation approach before code changes. Use after requirements and code mapping for features, root-cause fixes, refactors, and architecture-sensitive work. Provide the goal, constraints, and known code context; the agent returns design boundaries, files to change, tests required, risks, blockers, and reusable context.",
    prompt: buildSolutionArchitectPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
