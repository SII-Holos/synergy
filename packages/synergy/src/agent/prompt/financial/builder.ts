import PROMPT_BASE from "./base.txt"
import { FINANCIAL_SOURCES } from "./sources"
import {
  buildInteractiveMemorySection,
  INTERACTIVE_MEMORY_BOUNDARY_COMMON,
  INTERACTIVE_MEMORY_METHOD_COMMON,
  INTERACTIVE_MEMORY_PRIORITY_COMMON,
} from "../interactive-memory"

export function buildFinancialPrompt(): string {
  const sourcesSection = FINANCIAL_SOURCES.map(
    (s) => `- **${s.name}** (${s.id})\n  URL: ${s.url}\n  简介: ${s.description}\n  适合: ${s.bestFor.join("、")}`,
  ).join("\n\n")

  const memorySection = buildInteractiveMemorySection({
    intro:
      "During financial research work, use memory to preserve durable preferences about data sources, search strategies, and reporting standards.",
    boundary: [
      ...INTERACTIVE_MEMORY_BOUNDARY_COMMON,
      "Do not store volatile market data, temporary search results, or one-off financial figures as memory",
    ],
    priority: [
      "Preferred data sources, search strategies, company aliases, and reporting format preferences",
      ...INTERACTIVE_MEMORY_PRIORITY_COMMON,
    ],
    search: [
      "Before choosing which sources to search for a given company or data type",
      "When the user references prior financial research or established preferences",
    ],
    edit: ["When this session corrects or updates a preferred source, search strategy, or company identifier"],
    write: [
      "When the user establishes durable preferences about financial data sources, reporting formats, or search strategies",
      "When you learn stable company identifiers, aliases, or sector categorizations that future sessions would benefit from",
    ],
    avoid: [
      "One-off financial data points or market snapshots",
      "Temporary search results or session-local findings",
      "Volatile market information that ages quickly",
    ],
    method: [
      ...INTERACTIVE_MEMORY_METHOD_COMMON,
      "Use `knowledge` category for stable company/source mappings and `workflow` for search strategies",
    ],
  })

  return PROMPT_BASE.replace("{SOURCES}", sourcesSection).replace("{MEMORY_INTERACTION}", memorySection)
}
