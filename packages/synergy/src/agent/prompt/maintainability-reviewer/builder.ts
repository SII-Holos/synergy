import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildMaintainabilityReviewerPrompt(): string {
  return PROMPT_BASE
}

export function createMaintainabilityReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "maintainability-reviewer",
    description:
      "Reviews code maintainability after implementation or refactor. Use before delivery for meaningful code changes. Provide task goal, changed files or diff summary if available, and prior findings; the agent inspects missing code context and returns readability, structure, abstraction, duplication, blocker, and reusable-context findings.",
    prompt: buildMaintainabilityReviewerPrompt(),
    model: "thinking",
    permission: "review",
  })
}
