import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["parse_code"],
    render: () =>
      "Use parse_code for AST-aware structural search when the syntax shape is known. Its matches include anchored file blocks that can support an edit; inspect the complete relevant region and use only current tags returned by the tools.",
  },
]

export function registerCodePrompts() {
  AgentPromptContributions.register("code-tools", contributions)
}
