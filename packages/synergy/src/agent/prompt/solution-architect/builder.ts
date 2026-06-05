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
      "Designs the implementation approach before code changes. Use after requirements and code mapping for new features, root-cause bug fixes, refactors, and architecture-sensitive work. Produces module boundaries, APIs, data shapes, test strategy, rejected alternatives, and risks.",
    prompt: buildSolutionArchitectPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
