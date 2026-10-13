import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base(agent, identity) {
    if (
      identity.source === "builtin" &&
      ((identity.owner === "blueprint" && identity.registrationKey === "supervisor") ||
        (identity.owner === "light-loop" && identity.registrationKey === "lightloop-reviewer"))
    )
      return PermissionNext.fromConfig({ "browser_*": "allow" })
    return identity.owner === "harness" && agent.mode === "subagent"
      ? PermissionNext.fromConfig({ "browser_*": "allow" })
      : []
  },
}
export function registerAgentPermissions() {
  AgentPermissionContributions.register("browser-runtime", contribution)
}
