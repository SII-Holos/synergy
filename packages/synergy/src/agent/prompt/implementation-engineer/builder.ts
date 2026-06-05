import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildImplementationEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createImplementationEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "implementation-engineer",
    description:
      "Implements production code from requirements, design, and failing tests. Use only after behavior and test expectations are clear. Writes the smallest correct change, follows local patterns, runs narrow verification, and returns conflicts instead of guessing.",
    prompt: buildImplementationEngineerPrompt(),
    model: "mid",
    permission: "implementation",
  })
}
