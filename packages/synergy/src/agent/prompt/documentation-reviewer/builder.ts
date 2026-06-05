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
      "Reviews documentation for correctness and terminology. Use after documentation changes or code changes with user-facing behavior. Checks docs against implementation, command names, config paths, current vocabulary, examples, and agent-facing descriptions.",
    prompt: buildDocumentationReviewerPrompt(),
    model: "mid",
    permission: "analysis",
  })
}
