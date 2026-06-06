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
      "Reviews security and trust boundaries. Use for tools, shell execution, file access, permissions, credentials, auth, channels, external APIs, dependency changes, and user-identity or outbound actions. Provide the task goal and changed surface; the agent inspects missing evidence and returns risks, blockers, and reusable context.",
    prompt: buildSecurityReviewerPrompt(),
    model: "thinking",
    permission: "review",
  })
}
