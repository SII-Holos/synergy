import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
export function registerAgentContributions() {
  AgentPermissionContributions.register("agenda", {
    base: (agent, identity) =>
      (identity.owner === "harness" && agent.mode === "subagent") ||
      (identity.source === "builtin" &&
        ((identity.owner === "blueprint" && identity.registrationKey === "supervisor") ||
          (identity.owner === "light-loop" && identity.registrationKey === "lightloop-reviewer")))
        ? PermissionNext.fromConfig({ agenda_list: "allow", agenda_logs: "allow" })
        : [],
  })
}
