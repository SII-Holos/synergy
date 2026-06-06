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
      "Implements production code from requirements, design, and failing tests. Use only after behavior and scope are clear. Provide the goal, known context, relevant prior findings, and constraints; the agent inspects missing code context, writes the smallest scoped change, runs narrow validation, and returns blockers and reusable context.",
    prompt: buildImplementationEngineerPrompt(),
    model: "mid",
    permission: "codeWrite",
  })
}
