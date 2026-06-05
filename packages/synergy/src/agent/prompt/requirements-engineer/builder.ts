import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildRequirementsEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createRequirementsEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "requirements-engineer",
    description:
      "Turns an accepted intent into testable engineering requirements. Use before design or implementation when behavior, acceptance criteria, edge cases, non-goals, or scope boundaries must be made explicit.",
    prompt: buildRequirementsEngineerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
