import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildPropertyTestEngineerPrompt(): string {
  return PROMPT_BASE
}

export function createPropertyTestEngineerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "property-test-engineer",
    description:
      "Designs property-based tests for algorithms, parsers, serializers, normalizers, validators, state machines, and data transformations. Uses Hypothesis, fast-check, proptest, or local equivalents when invariants matter more than examples.",
    prompt: buildPropertyTestEngineerPrompt(),
    model: "thinking",
    permission: "implementation",
  })
}
