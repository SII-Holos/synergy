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
      "Reviews public contract impact after code changes. Use when changes may affect tool schemas, route schemas, SDK types, config fields, CLI behavior, plugin APIs, agent names, prompt-visible descriptions, or UI registrations. Provide the goal, changed files or prior findings if available; the agent inspects missing evidence and returns contract changes, wiring follow-ups, blockers, and reusable context.",
    prompt: buildApiCompatibilityReviewerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
