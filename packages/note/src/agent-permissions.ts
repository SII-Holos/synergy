import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base(agent, identity) {
    if (identity.owner === "boss" || (identity.owner === "library" && identity.registrationKey === "chronicler"))
      return PermissionNext.fromConfig({
        note_list: "allow",
        note_read: "allow",
        note_search: "allow",
        note_write: "allow",
        note_edit: "allow",
      })
    if (
      (identity.owner === "harness" && agent.mode === "subagent") ||
      (identity.source === "builtin" &&
        ((identity.owner === "blueprint" && identity.registrationKey === "supervisor") ||
          (identity.owner === "light-loop" && identity.registrationKey === "lightloop-reviewer")))
    )
      return PermissionNext.fromConfig({ note_list: "allow", note_read: "allow", note_search: "allow" })
    return []
  },
}

export function registerNoteAgentPermissions() {
  AgentPermissionContributions.register("note", contribution)
}
