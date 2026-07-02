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
      "Designs narrowly scoped tests when automated coverage is the right verification. Use for new behavior, behavior changes, risky refactors, and gaps that existing checks do not cover. Provide requirements, known context, and existing test patterns if available; the agent returns test strategy, tests added or no-new-test rationale, verification command, blockers, and reusable context.",
    prompt: buildTestStrategistPrompt(),
    model: "thinking",
    permission: "anchoredTestWrite",
  })
}
