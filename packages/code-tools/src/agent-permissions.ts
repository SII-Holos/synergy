import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base(_agent, identity) {
    if (
      identity.source === "builtin" &&
      ((identity.owner === "blueprint" && identity.registrationKey === "supervisor") ||
        (identity.owner === "light-loop" && identity.registrationKey === "lightloop-reviewer"))
    )
      return PermissionNext.fromConfig({ parse_code: "allow" })
    if (identity.owner !== "harness") return []
    if (identity.primaryRole === "coding" || identity.subagentProfile)
      return PermissionNext.fromConfig({ parse_code: "allow" })
    if (identity.primaryRole === "lightweight") return PermissionNext.fromConfig({ parse_code: "deny" })
    if (identity.primaryRole === "general") return PermissionNext.fromConfig({ parse_code: "deny" })
    return []
  },
}

export function registerAgentPermissions() {
  AgentPermissionContributions.register("code-tools", contribution)
}
