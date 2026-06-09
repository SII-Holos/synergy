import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildNoteLibrarianPrompt(): string {
  return PROMPT_BASE
}

export function createNoteLibrarianAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "note-librarian",
    description:
      "Manages long-form notes for synergy-max. Use when the task needs prior design notes, research summaries, project knowledge, note search, note synthesis, or durable note creation/update. Provide the topic, scope, known context, and intended use; the agent can search, read, create, and edit notes, then returns notes read, note changes, findings, blockers, and reusable compressed context.",
    prompt: buildNoteLibrarianPrompt(),
    model: "mid",
    permission: "note",
  })
}
