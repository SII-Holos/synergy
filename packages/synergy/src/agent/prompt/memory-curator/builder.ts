import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildMemoryCuratorPrompt(): string {
  return PROMPT_BASE
}

export function createMemoryCuratorAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "memory-curator",
    description:
      "Curates long-term memory for synergy-max. Use when the task needs prior user preferences, durable collaboration rules, trust boundaries, identity facts, recurring workflow expectations, or memory maintenance. Provide the user goal, known context, and what kind of memory question exists; the agent can search, retrieve, write, and edit memories, then returns searches, retrieved memories, memory changes, blockers, and reusable context.",
    prompt: buildMemoryCuratorPrompt(),
    model: "mid",
    permission: "memory",
  })
}
