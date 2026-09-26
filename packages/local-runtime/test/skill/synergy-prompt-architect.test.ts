import { describeBuiltinContract } from "./builtin-contract"

describeBuiltinContract({
  skillName: "synergy-prompt-architect",
  descriptionKeywords: ["system prompt", "agent", "role", "tool"],
  bodyPhrases: [
    "Layered architecture",
    "Role and mission",
    "Prompt vs runtime separation",
    "runtime tool spec",
    "## Reference files",
  ],
  references: {
    "references/prompt-engineering-principles.txt": ["## Principles"],
    "references/evaluation-checklist.txt": ["## Evaluation checklist"],
    "references/capability-modules.txt": ["## Capability modules"],
  },
  slashCommand: true,
})
