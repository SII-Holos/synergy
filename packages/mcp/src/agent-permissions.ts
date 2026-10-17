import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base(agent, identity) {
    return identity.owner === "harness" &&
      agent.mode === "subagent" &&
      ["externalResearch", "research"].includes(identity.subagentProfile ?? "")
      ? PermissionNext.fromConfig({ "mcp__*": "allow" })
      : []
  },
}
export function registerAgentPermissions() {
  AgentPermissionContributions.register("mcp", contribution)
}
