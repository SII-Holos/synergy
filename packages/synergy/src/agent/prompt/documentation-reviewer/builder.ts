import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildDocumentationReviewerPrompt(): string {
  return PROMPT_BASE
}

export function createDocumentationReviewerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "documentation-reviewer",
    description:
      "Reviews documentation correctness and terminology. Use after docs changes or code changes with user-facing behavior. Provide changed docs or summary if available; the agent inspects missing implementation evidence and returns inconsistencies, missing docs, stale terminology, blockers, and reusable context.",
    prompt: buildDocumentationReviewerPrompt(),
    model: "mid",
    permission: "review",
  })
}
