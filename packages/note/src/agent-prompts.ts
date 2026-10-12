import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["note_read", "note_write", "note_edit"],
    render(_agent, identity) {
      if (identity?.owner !== "boss") return ""
      return "Use the available Note tools to retain reports and decisions when the user requests a durable document. Read an existing note before editing it, and keep document content separate from operational state."
    },
  },
]

export function registerNotePrompts() {
  AgentPromptContributions.register("note", contributions)
}
