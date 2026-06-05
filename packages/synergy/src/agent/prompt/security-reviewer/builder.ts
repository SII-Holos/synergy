import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildSecurityReviewerPrompt(): string {
  return PROMPT_BASE
}

export function createSecurityReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "security-reviewer",
    description:
      "Reviews security and trust boundaries. Use for tools, shell execution, file access, permissions, credentials, auth, channels, external APIs, dependency changes, and any action that could affect users or external systems.",
    prompt: buildSecurityReviewerPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
