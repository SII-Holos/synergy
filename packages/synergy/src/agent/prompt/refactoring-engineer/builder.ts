import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildRefactoringEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createRefactoringEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "refactoring-engineer",
    description:
      "Performs behavior-preserving refactors after tests are green. Use when code works but structure, naming, duplication, control flow, or module boundaries need improvement. Does not add features or alter public behavior.",
    prompt: buildRefactoringEngineerPrompt(),
    model: "mid",
    permission: "implementation",
  })
}
