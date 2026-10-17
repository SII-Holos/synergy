import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { SessionWorkflowHold } from "@ericsanchezok/synergy-harness/session/workflow-hold"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import {
  bindingSourceMigration,
  bindingSourceAccessMigration,
  controlSourceMigration,
} from "./binding-source-migration"
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function upgradeWaitingPhase(key: string[], value: Record<string, unknown>) {
  if (key.length !== 4 || key[0] !== "sessions" || key[3] !== "info") return
  const blueprint = record(value.blueprint)
  if (blueprint?.phase !== "waiting") return
  const paused = SessionWorkflowHold.latchFor(value)
  value.blueprint = { ...blueprint, phase: "running" }
  if (paused) value.paused = paused
}

async function upgradeWaitingSession(owner: { scopeID: string; sessionID: string }) {
  const key = StoragePath.sessionInfo(Identifier.asScopeID(owner.scopeID), Identifier.asSessionID(owner.sessionID))
  await Storage.transaction(async () => {
    const [value] = await Storage.readMany<Record<string, unknown>>([key])
    if (!value || record(value.blueprint)?.phase !== "waiting") return
    upgradeWaitingPhase(key, value)
    await Storage.write(key, value)
  })
}

export const waitingPhaseMigration: Migration = {
  id: "20261012-blueprint-session-waiting-phase",
  description: "Move a retained Blueprint hold to the Session pause latch when its owner is selected",
  scope: "session",
  execution: "session",
  onAccess: (session) => record(session.blueprint)?.phase === "waiting",
  upgradeRecord: upgradeWaitingPhase,
  upSession: upgradeWaitingSession,
  async up(progress) {
    let count = 0
    for await (const item of Storage.records({ kind: "session" })) {
      await upgradeWaitingSession({ scopeID: item.key[1]!, sessionID: item.key[2]! })
      progress(++count, 0)
    }
    progress(count, count)
  },
}

export function upgradeOwnerSession(key: string[], value: Record<string, unknown>) {
  if (key[0] !== "sessions") return
  if (key.length === 4 && key[3] === "info") {
    if (
      value.planMode === true &&
      !value.workflow &&
      !value.lattice &&
      !record(value.lightLoop)?.active &&
      !record(value.blueprint)?.loopID
    ) {
      value.workflow = { kind: "plan" }
      delete value.planMode
    }
  }
  if (key.length === 6 && key[3] === "messages" && key[5] === "info") {
    const metadata = record(value.metadata)
    if (!metadata) return
    const kind =
      metadata.workflowMode === "light_loop"
        ? "lightloop"
        : (metadata.workflowMode ?? (metadata.planModeRequest === true ? "plan" : undefined))
    if (kind !== "plan") return
    metadata.workflow = kind
    metadata.workflowVersion = 1
    const agent = metadata.workflowModeAgent ?? metadata.planModeAgent
    if (typeof agent === "string") metadata.workflowAgent = agent
    for (const field of [
      "planModeRequest",
      "planModeAgent",
      "planModeWrapperVersion",
      "workflowMode",
      "workflowModeAgent",
      "workflowModeVersion",
    ])
      delete metadata[field]
  }
}
async function upgradeSession(owner: { scopeID: string; sessionID: string }) {
  const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
  await Storage.transaction(async () => {
    const [value] = await Storage.readMany<Record<string, unknown>>([key])
    if (!value) return
    const before = JSON.stringify(value)
    upgradeOwnerSession(key, value)
    if (before !== JSON.stringify(value)) await Storage.write(key, value)
  })
}

export const migrations: Migration[] = [
  waitingPhaseMigration,
  bindingSourceMigration,
  bindingSourceAccessMigration,
  controlSourceMigration,
  {
    id: "20261012-blueprint-session-owner",
    description: "Upgrade retained blueprint Session state when its owner is selected",
    scope: "session",
    execution: "record",
    onAccess: (session) => session.planMode === true,
    upSession: upgradeSession,
    upgradeRecord: upgradeOwnerSession,
    async up(progress) {
      let count = 0
      for await (const { key } of Storage.records({ kind: "session" })) {
        await upgradeSession({ scopeID: key[1]!, sessionID: key[2]! })
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
]
export function registerSessionMigrations() {
  MigrationRegistry.register("blueprint-session", migrations)
}
