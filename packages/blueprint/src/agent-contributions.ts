import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
export function registerAgentContributions() {
  AgentPermissionContributions.register("blueprint", {
    base: (agent, identity) =>
      identity.owner === "harness" && agent.mode === "subagent"
        ? PermissionNext.fromConfig({
            blueprint_loop_stop: "allow",
            blueprint_loop_approve: "allow",
            blueprint_loop_reject: "allow",
          })
        : [],
  })
}
