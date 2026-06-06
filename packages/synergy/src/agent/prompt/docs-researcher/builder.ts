import type { BuiltinAgentContext } from "../../builtin-context"
import { createSubagent } from "../../builtin-context"
import PROMPT_BASE from "./base.txt"

export function buildDocsResearcherPrompt(): string {
  return PROMPT_BASE
}

export function createDocsResearcherAgent(ctx: BuiltinAgentContext) {
  return createSubagent(ctx, {
    name: "docs-researcher",
    description:
      "Researches current external technical documentation and open-source examples. Use before relying on library APIs, CLI flags, configuration formats, framework behavior, release changes, migration guides, or ecosystem best practices. Provide the technical question and version constraints; the agent returns sources, recommendations, caveats, blockers, and reusable context.",
    prompt: buildDocsResearcherPrompt(),
    model: "mid",
    permission: "externalResearch",
  })
}
