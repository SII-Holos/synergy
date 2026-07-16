import type { Agent } from "./agent"
import type { BuiltinAgentContext } from "./builtin-context"
import { createSubagent } from "./builtin-context"
import PROMPT_ADVISOR from "./prompt/advisor.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_INSPECTOR from "./prompt/inspector.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import { buildDeveloperPrompt } from "./prompt/developer/builder"
import { buildScholarPrompt } from "./prompt/scholar/builder"
import { buildScribePrompt } from "./prompt/scribe/builder"

export function createBuiltinLegacySubagents(ctx: BuiltinAgentContext): Record<string, Agent.Info> {
  const agents = [
    createSubagent(ctx, {
      name: "developer",
      description:
        "General-purpose coding subagent for direct implementation, debugging, refactoring, and test updates when the task is well scoped. Use for the classic synergy workflow when a single executor should make code changes and run relevant validation.",
      prompt: buildDeveloperPrompt(),
      model: "thinking",
      permission: "codeWrite",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "explore",
      description:
        "Read-only codebase exploration subagent. Use to find where functionality lives, map relevant files, locate call sites, and summarize current implementation before coding in the classic synergy workflow.",
      prompt: PROMPT_EXPLORE,
      model: "mid",
      permission: "readOnly",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "scout",
      description:
        "External technical documentation and open-source research subagent. Use to verify current library APIs, CLI flags, examples, release notes, and ecosystem practices in the classic synergy workflow.",
      prompt: PROMPT_SCOUT,
      model: "mid",
      permission: "externalResearch",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "advisor",
      description:
        "Read-only strategic advisor for architecture, design tradeoffs, repeated failures, and difficult debugging in the classic synergy workflow. Use for a second opinion before committing to a risky approach.",
      prompt: PROMPT_ADVISOR,
      model: "thinking",
      permission: "review",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "inspector",
      description:
        "Read-only code quality auditor for readability, unnecessary indirection, structural density, hygiene, dead code, and patch-over-fix patterns in the classic synergy workflow.",
      prompt: PROMPT_INSPECTOR,
      model: "mid",
      permission: "review",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "scribe",
      description:
        "Writing and documentation subagent for substantial prose, guides, documentation drafts, release notes, and narrative polishing in the classic synergy workflow.",
      prompt: buildScribePrompt(),
      model: "creative",
      permission: "docsWrite",
      visibleTo: ["synergy"],
    }),
    createSubagent(ctx, {
      name: "scholar",
      description:
        "Academic and research subagent for literature review, paper analysis, research context, methodology, and scholarly synthesis in the classic synergy workflow.",
      prompt: buildScholarPrompt(),
      model: "thinking",
      permission: "research",
      visibleTo: ["synergy"],
    }),
  ]

  return Object.fromEntries(agents.map((agent) => [agent.name, agent]))
}
