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
      "Performs behavior-preserving refactors after tests are green. Use when structure, naming, duplication, control flow, or module boundaries need improvement without changing behavior. Provide target files, review findings, and validation command if known; the agent returns refactor summary, tests run, blockers, and reusable context.",
    prompt: buildRefactoringEngineerPrompt(),
    model: "mid",
    permission: "implementation",
  })
}
