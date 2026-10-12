import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { readConfig } from "./config-schema"

const contribution: AgentPermissionContributions.Contribution = async (agent) => {
  if (agent.mode !== "primary" || agent.hidden) return []
  const writeDenied = agent.permission.some(
    (rule) => ["memory_write", "memory_edit"].includes(rule.permission) && rule.action === "deny",
  )
  const { library } = await readConfig()
  const evolutionActive = (library?.memory?.enabled ?? true) && library?.experience?.encode !== false
  const restrictRecall =
    !evolutionActive &&
    [PrimaryAgentIdentity.names.general, PrimaryAgentIdentity.names.lightweight].some((name) => name === agent.name)
  const config = await Config.current()
  const configuredAgent = Object.entries(config.agent ?? {}).find(
    ([id, value]) => (value.name ?? id) === agent.name,
  )?.[1]
  return PermissionNext.merge(
    ...(restrictRecall
      ? [
          PermissionNext.fromConfig({ memory_search: "deny", memory_get: "deny" }),
          PermissionNext.fromConfig(config.permission ?? {}),
          PermissionNext.fromConfig(configuredAgent?.permission ?? {}),
        ]
      : []),
    writeDenied ? [] : PermissionNext.fromConfig({ memory_write: "allow", memory_edit: "allow" }),
  )
}

export function registerLibraryAgentPermissions() {
  AgentPermissionContributions.register("library", contribution)
}
