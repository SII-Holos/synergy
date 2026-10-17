import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

const contributions: readonly AgentPromptContributions.Contribution[] = [
  {
    requiredTools: ["note_read", "note_write", "note_edit"],
    render(_agent, identity) {
      if (identity?.owner !== "boss") return ""
      return "Retain reports and decisions as durable documents when the user requests them. Keep document content separate from operational state."
    },
  },
]

export function registerNotePrompts() {
  AgentPromptContributions.register("note", contributions)
}
