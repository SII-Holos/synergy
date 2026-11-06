import type { Migration } from "../migration/types"
import { SessionMigrationTarget } from "../migration/session-target"
import { PrimaryAgentUpgrade } from "../agent/primary-identity-upgrade"
import { Storage } from "../storage/storage"
import { SessionHistoryDisplay } from "./history-display"

function upgradeRecord(key: string[], value: Record<string, unknown>) {
  if (key[0] !== "sessions") return
  if (key.length === 4 && key[3] === "info") {
    PrimaryAgentUpgrade.fields(value, ["agentOverride"])
    PrimaryAgentUpgrade.fields(value.cortex, ["agent"])
    if (Array.isArray(value.permission))
      for (const rule of value.permission) {
        if (PrimaryAgentUpgrade.record(rule)?.permission === "task") PrimaryAgentUpgrade.fields(rule, ["pattern"])
      }
  }
  if (key.length === 6 && key[3] === "messages" && key[5] === "info") {
    PrimaryAgentUpgrade.fields(value, ["agent"])
    if (value.role === "assistant") PrimaryAgentUpgrade.fields(value, ["mode"])
  }
  if (key.length === 5 && ["inbox", "inbox-removed"].includes(key[3])) {
    const item = key[3] === "inbox-removed" ? PrimaryAgentUpgrade.record(value.item) : value
    PrimaryAgentUpgrade.fields(item?.message, ["agent"])
    PrimaryAgentUpgrade.fields(item?.input, ["agent"])
  }
}

async function upgradeRecords(progress: Parameters<Migration["up"]>[0]) {
  let done = 0
  for (const kind of ["session", "message", "inbox", "inbox-removed"]) {
    for await (const { key, value } of SessionMigrationTarget.records<Record<string, unknown>>({ kind })) {
      const before = JSON.stringify(value)
      upgradeRecord(key, value)
      if (before !== JSON.stringify(value))
        await Storage.transaction(async () => {
          await Storage.write(key, value)
          if (kind === "message") await SessionHistoryDisplay.invalidate(key[1], key[2])
        })
      progress(++done, 0)
    }
  }
  progress(done, done)
}

export const primaryAgentMigration: Migration = {
  id: "20261002-session-primary-agent-identities",
  description: "Upgrade primary agent identities in Sessions, messages and pending input",
  scope: "session",
  emptyInput: [["sessions"]],
  upgradeRecord,
  upSession(owner, progress) {
    return SessionMigrationTarget.provide(owner, () => upgradeRecords(progress))
  },
  up: upgradeRecords,
}
