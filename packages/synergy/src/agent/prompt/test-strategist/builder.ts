import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildTestStrategistPrompt(): string {
  return PROMPT_BASE
}

export function createTestStrategistAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "test-strategist",
    description:
      "Designs and writes tests before implementation. Use for new behavior, behavior changes, risky refactors, and TDD workflows. Provide requirements, known context, and existing test patterns if available; the agent returns test strategy, red tests, expected failure, verification command, blockers, and reusable context.",
    prompt: buildTestStrategistPrompt(),
    model: "thinking",
    permission: "testWrite",
  })
}
