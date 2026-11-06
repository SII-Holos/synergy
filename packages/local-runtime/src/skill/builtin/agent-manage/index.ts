import CONTENT from "./content.txt"
import FIELDS from "./references/fields.txt"

export const agentManage = {
  name: "agent-manage",
  description:
    "Create, update, disable, delete, and inspect Synergy agents and set the default agent through validated agent_config writes. Use when the user wants to build a custom agent ('make me an agent that...'), change an agent's model, prompt, permissions, visibility, or mode, disable or remove an agent, list where agents are defined, or choose which agent new sessions use by default. Covers project and global agent configuration, not built-in agent source code.",
  content: CONTENT,
  builtin: true as const,
  references: {
    "references/fields.txt": FIELDS,
  },
}
