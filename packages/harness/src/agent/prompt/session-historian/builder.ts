import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildSessionHistorianPrompt(): string {
  return PROMPT_BASE
}

export function createSessionHistorianAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "session-historian",
    description:
      "Recovers historical session context for synergy-max. Use when the user refers to prior conversations, compacted context, earlier decisions, old plans, recurring preferences, or previous evidence. Provide the topic, likely timeframe if known, and why history matters; the agent can list, search, and read sessions, then returns searches, sessions read, timeline, conflicts, blockers, and reusable context. It cannot send or control sessions.",
    prompt: buildSessionHistorianPrompt(),
    model: "mid",
    permission: "sessionHistory",
  })
}
