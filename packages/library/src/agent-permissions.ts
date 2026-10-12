import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { readConfig } from "./config-schema"

const contribution: AgentPermissionContributions.Phases = {
  async base(_agent, identity) {
    if (identity.primaryRole !== "general" && identity.primaryRole !== "lightweight") return []
    const { library } = await readConfig()
    const evolutionActive = (library?.memory?.enabled ?? true) && library?.experience?.encode !== false
    return evolutionActive ? [] : PermissionNext.fromConfig({ memory_search: "deny", memory_get: "deny" })
  },
  final(agent) {
    if (agent.mode !== "primary" || agent.hidden) return []
    const writeDenied = agent.permission.some(
      (rule) => ["memory_write", "memory_edit"].includes(rule.permission) && rule.action === "deny",
    )
    return writeDenied ? [] : PermissionNext.fromConfig({ memory_write: "allow", memory_edit: "allow" })
  },
}

export function registerLibraryAgentPermissions() {
  AgentPermissionContributions.register("library", contribution)
}
