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
      "Classifies user requests before execution. Use for ambiguous, broad, multi-step, or risky work. Provide the user request, session goal, known constraints, and any prior context; the agent returns task type, risk, hidden assumptions, workflow recommendation, blockers, and reusable context for downstream planning.",
    prompt: buildIntentAnalystPrompt(),
    model: "mid",
    permission: "readOnly",
  })
}
