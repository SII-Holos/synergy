import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildRegressionReproducerPrompt(): string {
  return PROMPT_BASE
}

export function createRegressionReproducerAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "regression-reproducer",
    description:
      "Creates deterministic reproductions for bugs before fixes. Use for crashes, wrong outputs, regressions, flaky behavior, and user-reported defects. Provide the bug report and known symptoms; the agent returns reproduction status, failing test or command, failure output, hypotheses, blockers, and reusable context. NOT for test suite writing (use test-strategist), fixture building (use fixture-builder), or implementing the fix (use implementation-engineer).",
    prompt: buildRegressionReproducerPrompt(),
    model: "mid",
    permission: "anchoredTestWrite",
  })
}
