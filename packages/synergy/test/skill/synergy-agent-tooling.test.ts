import { describeBuiltinContract } from "./builtin-contract"

describeBuiltinContract({
  skillName: "synergy-agent-tooling",
  descriptionKeywords: ["tool", "mcp", "cli"],
  bodyPhrases: [
    "Tool contract",
    "consolidation",
    "## Reference files",
    // The repo-routing clause must survive content edits.
    "repository `add-tool` workflow",
  ],
  references: {
    // The MCP qualified-name form must match what the runtime exposes.
    "references/tool-design.txt": ["## Audit checklist", "mcp__<server>__<tool>"],
    "references/mcp-builder.txt": ["## Workflow"],
    "references/cli-creator.txt": ["## Command contract"],
  },
  slashCommand: true,
})
