import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildLiteratureAnalystPrompt(): string {
  return PROMPT_BASE
}

export function createLiteratureAnalystAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "literature-analyst",
    description:
      "Deep-reads and synthesizes academic literature. Use after literature-searcher has produced a curated paper list. Provide the research question, the paper list with arXiv IDs, and the synthesis goal; the agent downloads and close-reads papers, evaluates methodology and evidence quality, compares approaches, identifies gaps, and returns a structured literature synthesis with reusable context for design and implementation decisions.",
    prompt: buildLiteratureAnalystPrompt(),
    model: "thinking",
    permission: "research",
  })
}
