import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base: () => PermissionNext.fromConfig({ "mcp__*": "allow" }),
}
export function registerAgentPermissions() {
  AgentPermissionContributions.register("mcp", contribution)
}
