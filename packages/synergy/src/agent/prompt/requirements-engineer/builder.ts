import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildRequirementsEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createRequirementsEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "requirements-engineer",
    description:
      "Converts accepted intent into testable engineering requirements. Use before design, testing, or implementation when behavior, edge cases, acceptance criteria, forbidden behavior, or scope boundaries must be explicit. Provide the goal, known context, and prior findings; the agent returns behavioral specs, testable claims, blockers, and reusable context. NOT for code exploration (use code-cartographer), writing tests (use test-strategist), or writing code (use implementation-engineer).",
    prompt: buildRequirementsEngineerPrompt(),
    model: "mid",
    permission: "readOnly",
  })
}
