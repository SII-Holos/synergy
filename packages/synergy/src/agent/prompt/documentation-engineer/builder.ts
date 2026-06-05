import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildDocumentationEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createDocumentationEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "documentation-engineer",
    description:
      "Updates engineering documentation after code, tool, agent, config, CLI, SDK, or workflow changes. Use when public behavior or agent-facing instructions change. Writes concise current docs without stale terminology or development narration.",
    prompt: buildDocumentationEngineerPrompt(),
    model: "mid",
    permission: "documentation",
  })
}
