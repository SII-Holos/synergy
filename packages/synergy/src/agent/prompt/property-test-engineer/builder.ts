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
      "Designs property-based tests for invariants. Use for algorithms, parsers, serializers, normalizers, validators, state machines, and data transformations. Provide the target behavior and language context; the agent returns properties, generators, property tests, failure interpretation, blockers, and reusable context. NOT for behavioral correctness tests (use test-strategist), bug reproduction (use regression-reproducer), or type contract verification (use type-test-engineer).",
    prompt: buildPropertyTestEngineerPrompt(),
    model: "thinking",
    permission: "anchoredTestWrite",
  })
}
