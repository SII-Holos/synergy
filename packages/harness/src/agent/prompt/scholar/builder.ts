import PROMPT_BASE from "./base.txt"
import {
  buildInteractiveMemorySection,
  INTERACTIVE_MEMORY_BOUNDARY_COMMON,
  INTERACTIVE_MEMORY_METHOD_COMMON,
  INTERACTIVE_MEMORY_PRIORITY_COMMON,
} from "../interactive-memory"

export function buildScholarPrompt(): string {
  const memorySection = buildInteractiveMemorySection({
    intro:
      "During user-facing research work, use memory to preserve durable standards and preferences that should shape future investigations.",
    boundary: [
      ...INTERACTIVE_MEMORY_BOUNDARY_COMMON,
      "Do not turn a provisional literature read, temporary framing, or speculative interpretation into a durable memory unless the lasting rule is about the user's research preferences or standards",
    ],
    priority: [
      "Stable evidence standards, citation expectations, methodological preferences, or terminology rules the user wants applied repeatedly",
      ...INTERACTIVE_MEMORY_PRIORITY_COMMON,
    ],
    search: [
      "Before assuming the user's preferred depth, evidence standard, citation style, or source preferences",
      "When the user refers to prior evaluations, recurring research themes, or previously established terminology",
      "When prior context might change how you frame uncertainty, methodology, or literature selection",
    ],
    edit: [
      "When this session corrects or sharpens an existing memory about research expectations, terminology, or domain conventions",
      "When a previously stored preference is still related but now needs a cleaner category or recall mode",
    ],
    write: [
      "When the user clearly establishes durable research preferences, methodological standards, source preferences, or explanation depth expectations",
      "When you learn stable project research conventions or durable domain framing that future sessions would benefit from",
      "When you explicitly promise to remember a lasting research constraint and it has been clearly established in the interaction",
    ],
    avoid: [
      "One-off paper lists, temporary reading queues, or survey snapshots that belong in notes or files",
      "Volatile frontier claims that are likely to age quickly",
      "Session-local framing that has not proven durable",
      "A tentative interpretation of current literature when the durable lesson is not yet clear",
    ],
    method: [
      ...INTERACTIVE_MEMORY_METHOD_COMMON,
      "Use `workflow`, `writing`, `interaction`, `relationship`, or `knowledge` deliberately based on what was learned",
      "Prefer notes or files over memory for evolving literature maps, reading queues, or survey results",
    ],
  })

  return PROMPT_BASE.replace("{MEMORY_INTERACTION}", memorySection)
}
