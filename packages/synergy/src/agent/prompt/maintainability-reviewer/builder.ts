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
      "Reviews code maintainability after implementation. Use before final delivery for meaningful code changes. Audits readability, naming, control flow, abstraction depth, duplication, structure density, dead code, and patch-over-fix patterns.",
    prompt: buildMaintainabilityReviewerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
