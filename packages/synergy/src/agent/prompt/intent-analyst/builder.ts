import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildIntentAnalystPrompt(): string {
  return PROMPT_BASE
}

export function createIntentAnalystAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "intent-analyst",
    description:
      "Classifies user requests before execution. Use when the task is ambiguous, broad, multi-step, or risky. Produces intent, task type, risk level, hidden constraints, workflow recommendation, and structured decision requests for synergy to broker with the user.",
    prompt: buildIntentAnalystPrompt(),
    model: "thinking",
    permission: "analysis",
  })
}
