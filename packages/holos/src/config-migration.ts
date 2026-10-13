import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function upgradeHolos(config: Record<string, unknown>) {
  delete config.holos_friend_reply_model
  const channel = record(config.channel)
  const legacy = record(channel?.holos)
  if (!legacy || !channel) return
  const accounts = record(legacy.accounts)
  const defaultAccount = record(accounts?.default)
  const recognized =
    Object.keys(legacy).length === 0 ||
    legacy.type === "holos" ||
    typeof legacy.enabled === "boolean" ||
    typeof defaultAccount?.enabled === "boolean" ||
    ["apiUrl", "wsUrl", "portalUrl"].some((key) => typeof legacy[key] === "string")
  if (!recognized || (config.holos !== undefined && !record(config.holos))) return
  if (config.holos === undefined) {
    config.holos = {
      enabled:
        typeof legacy.enabled === "boolean"
          ? legacy.enabled
          : typeof defaultAccount?.enabled === "boolean"
            ? defaultAccount.enabled
            : true,
      apiUrl: typeof legacy.apiUrl === "string" ? legacy.apiUrl : "https://api.holosai.io",
      wsUrl: typeof legacy.wsUrl === "string" ? legacy.wsUrl : "wss://api.holosai.io",
      portalUrl: typeof legacy.portalUrl === "string" ? legacy.portalUrl : "https://www.holosai.io",
    }
  }
  if (legacy.type === "holos") delete legacy.type
  if (typeof legacy.enabled === "boolean") delete legacy.enabled
  for (const key of ["apiUrl", "wsUrl", "portalUrl"]) if (typeof legacy[key] === "string") delete legacy[key]
  if (accounts && defaultAccount && typeof defaultAccount.enabled === "boolean") {
    delete defaultAccount.enabled
    if (!Object.keys(defaultAccount).length) delete accounts.default
    if (!Object.keys(accounts).length) delete legacy.accounts
  }
  if (!Object.keys(legacy).length) delete channel.holos
  if (!Object.keys(channel).length) delete config.channel
}

export const migrations: Migration[] = [
  {
    id: "20261012-holos-config-owner",
    configuration: "files",
    description: "Move retained Holos settings into the selected owner configuration",
    scope: "global",
    execution: "startup",
    upgradeConfig: upgradeHolos,
    up: ConfigReferenceMigration.up,
  },
]
