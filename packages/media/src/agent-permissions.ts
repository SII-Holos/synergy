import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"

const contribution: AgentPermissionContributions.Phases = {
  base(agent, identity) {
    if (identity.source === "builtin" && identity.owner === "blueprint" && identity.registrationKey === "supervisor")
      return PermissionNext.fromConfig({ look_at: "allow", scan_document: "allow" })
    if (identity.owner !== "harness") return []
    return PermissionNext.fromConfig({
      ...(agent.mode === "subagent" ? { look_at: "allow" } : {}),
      ...(identity.primaryRole === "coding" ||
      ["codeWrite", "testWrite", "docsWrite"].includes(identity.subagentProfile ?? "")
        ? { scan_document: "allow" }
        : {}),
    })
  },
}
export function registerAgentPermissions() {
  AgentPermissionContributions.register("media", contribution)
}
