import PROMPT_BASE from "./base.txt"
import {
  buildInteractiveMemorySection,
  INTERACTIVE_MEMORY_BOUNDARY_COMMON,
  INTERACTIVE_MEMORY_METHOD_COMMON,
  INTERACTIVE_MEMORY_PRIORITY_COMMON,
} from "../interactive-memory"

export function buildScribePrompt(): string {
  const memorySection = buildInteractiveMemorySection({
    intro:
      "During user-facing writing work, use memory to preserve durable editorial preferences that should shape future drafts and revisions.",
    boundary: [
      ...INTERACTIVE_MEMORY_BOUNDARY_COMMON,
      "Drafting text for the user is not the same as sending or publishing it on the user's behalf",
    ],
    priority: [
      "Repeated editorial rules about tone, structure, pacing, audience level, or forbidden stylistic habits",
      ...INTERACTIVE_MEMORY_PRIORITY_COMMON,
    ],
    search: [
      "Before assuming tone, language, structure, audience level, or formatting preferences",
      'When the user refers to "the style I like", "as usual", or prior draft feedback patterns',
      "When you suspect a prior editorial rule exists that should influence the current writing task",
    ],
    edit: [
      "When the user refines or corrects an existing writing preference",
      "When a stored preference is close but needs a sharper category, recall mode, or wording",
    ],
    write: [
      "When the user clearly establishes a durable writing preference about tone, structure, pacing, hierarchy, or audience targeting",
      "When repeated editorial guidance reveals a stable rule that should carry into future sessions",
      "When you explicitly say you will remember a lasting writing constraint and it has been clearly established",
    ],
    avoid: [
      "The current outline, one-off edits, or temporary draft experiments",
      "Topic facts that belong in the document rather than long-term memory",
      "Highly local stylistic decisions that have not been established as durable preferences",
      "A one-off request unless it clearly represents a stable editorial preference",
    ],
    method: [
      ...INTERACTIVE_MEMORY_METHOD_COMMON,
      "Use `writing`, `workflow`, `interaction`, or `relationship` deliberately based on what was learned",
    ],
  })

  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", memorySection)
}
