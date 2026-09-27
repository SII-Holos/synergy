import CONTENT from "./content.txt"
import PRINCIPLES from "./references/prompt-engineering-principles.txt"
import EVALUATION from "./references/evaluation-checklist.txt"
import CAPABILITIES from "./references/capability-modules.txt"

export const synergyPromptArchitect = {
  name: "synergy-prompt-architect",
  description:
    "Design, review, revise, or template deployable system prompts for agents: layered role/task/tool/output/safety structure, role definition from a professional identity plus domain, prompt-vs-runtime separation, capability vs runtime tool specs, and evaluation-driven revision. Use when the unit of work is a system prompt for an agent project; route config mechanics to synergy-config.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/prompt-engineering-principles.txt": PRINCIPLES,
    "references/evaluation-checklist.txt": EVALUATION,
    "references/capability-modules.txt": CAPABILITIES,
  },
}
