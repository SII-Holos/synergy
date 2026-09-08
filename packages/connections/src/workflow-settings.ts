import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { readConfig } from "./config-schema"

export async function readGithubWatchPolicy() {
  const watch = (await Config.globalResolved().catch(() => undefined))?.github?.watch
  return { enabled: watch?.enabled !== false, defaultIntervalMs: watch?.defaultIntervalMs }
}

export async function readBossAccounts() {
  const config = await readConfig()
  return Object.entries(config.channel?.feishu?.accounts ?? {}).map(([id, account]) => ({
    id,
    enabled: account.enabled !== false,
    hasProjectDirectory: Boolean(account.projectDir),
  }))
}
