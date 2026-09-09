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
      "Reviews code for human-quality concerns beyond toolchain checks: readability, naming, dead code, redundant logic, abandoned code, inline comment quality, unnecessary indirection, structural density, root-cause fit. Use for every meaningful code change alongside quality-gatekeeper. Provide task goal, changed files or diff summary if available, and prior findings; the agent inspects missing code context and returns production readiness, blockers, and reusable context.",
    prompt: buildMaintainabilityReviewerPrompt(),
    model: "thinking",
    permission: "review",
  })
}
