import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildApiCompatibilityReviewerPrompt(): string {
  return PROMPT_BASE
}

export function createApiCompatibilityReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "api-compatibility-reviewer",
    description:
      "Reviews compatibility of public contracts after changes. Use for tool schemas, route schemas, SDK output, config schemas, CLI behavior, plugin APIs, agent names, prompt-visible descriptions, and UI tool registrations.",
    prompt: buildApiCompatibilityReviewerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
