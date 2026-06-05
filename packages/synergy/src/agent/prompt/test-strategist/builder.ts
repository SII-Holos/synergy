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
      "Designs and writes tests before implementation. Use for new behavior, behavior changes, or risky refactors. Chooses the smallest useful test layer, writes red tests, avoids implementation-coupled assertions, and defines verification commands.",
    prompt: buildTestStrategistPrompt(),
    model: "thinking",
    permission: "implementation",
  })
}
