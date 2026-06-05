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
      "Builds deterministic reproductions for bugs before fixes. Use for bug reports, crashes, wrong outputs, regressions, and flaky behavior. Produces minimal failing tests or scripts, expected failure output, and ranked root-cause hypotheses.",
    prompt: buildRegressionReproducerPrompt(),
    model: "thinking",
    permission: "implementation",
  })
}
