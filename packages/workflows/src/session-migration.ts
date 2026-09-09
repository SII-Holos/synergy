import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
const log = Log.create({ service: "workflow.session-migration" })

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

function activeLoopStatus(status: unknown) {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

async function sessionHasActiveBlueprintLoop(info: Record<string, unknown>): Promise<boolean> {
  const scopeID = asString(asRecord(info.scope)?.id)
  const loopID = asString(asRecord(info.blueprint)?.loopID)
  if (!scopeID || !loopID) return false
  const loop = await Storage.read<Record<string, unknown>>(
    StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), loopID),
  ).catch(() => undefined)
  return activeLoopStatus(loop?.status)
}

function workflowFromLegacySession(info: Record<string, unknown>, hasActiveBlueprintLoop: boolean) {
  const lattice = asRecord(info.lattice)
  const latticeMode = lattice?.mode
  if (lattice && (latticeMode === "auto" || latticeMode === "collaborative")) {
    const runID = asString(lattice.runID)
    if (!runID) return undefined
    return compact({
      kind: "lattice",
      runID,
      mode: latticeMode,
      firstBlueprintStarted: lattice.firstBlueprintStarted === true ? true : undefined,
    })
  }

  if (hasActiveBlueprintLoop) return undefined

  const lightLoop = asRecord(info.lightLoop)
  if (lightLoop?.active === true) {
    const taskDescription = asString(lightLoop.taskDescription)
    if (taskDescription) return { kind: "lightloop", taskDescription }
  }

  if (info.planMode === true) return { kind: "plan" }
  return undefined
}

async function migrateSessionWorkflowFields(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
  const tasks: Array<{ scopeID: string; sessionID: string }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    for (const sessionID of sessionIDs) tasks.push({ scopeID, sessionID })
  }

  if (tasks.length === 0) return

  let done = 0
  let changed = 0
  for (const { scopeID, sessionID } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const path = StoragePath.sessionInfo(scope, sid)
    const info = await Storage.read<Record<string, unknown>>(path).catch(() => undefined)
    if (!info) {
      done++
      progress(done, tasks.length)
      continue
    }

    const hadLegacy = "planMode" in info || "lightLoop" in info || "lattice" in info
    if (hadLegacy) {
      const workflow = workflowFromLegacySession(info, await sessionHasActiveBlueprintLoop(info))
      delete info.planMode
      delete info.lightLoop
      delete info.lattice
      if (workflow) info.workflow = workflow
      else delete info.workflow
      await Storage.write(path, info)
      changed++
    }

    done++
    progress(done, tasks.length)
  }

  log.info("session workflow field migration complete", { total: tasks.length, changed })
}
async function migrateLightloopInstructionsField(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
  const tasks: Array<{ scopeID: string; sessionID: string }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    for (const sessionID of sessionIDs) tasks.push({ scopeID, sessionID })
  }

  if (tasks.length === 0) return

  let done = 0
  let changed = 0
  for (const { scopeID, sessionID } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const path = StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))
    const info = await Storage.read<Record<string, unknown>>(path).catch(() => undefined)
    if (!info) {
      done++
      progress(done, tasks.length)
      continue
    }

    let recordChanged = false
    let workflow = asRecord(info.workflow)
    const hadLegacy = "planMode" in info || "lightLoop" in info || "lattice" in info
    if (!workflow && hadLegacy) {
      workflow = workflowFromLegacySession(info, await sessionHasActiveBlueprintLoop(info))
      delete info.planMode
      delete info.lightLoop
      delete info.lattice
      if (workflow) info.workflow = workflow
      recordChanged = true
    }

    if (workflow?.kind === "lightloop") {
      const taskDescription = asString(workflow.taskDescription)
      if (taskDescription && !asString(workflow.instructions)) {
        workflow.instructions = taskDescription
        delete workflow.taskDescription
        info.workflow = workflow
        recordChanged = true
      }
    }

    if (recordChanged) {
      await Storage.write(path, info)
      changed++
    }
    done++
    progress(done, tasks.length)
  }

  log.info("Light Loop instructions field migration complete", { total: tasks.length, changed })
}

async function migrateTerminalLightloops(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
  const tasks: Array<{ scopeID: string; sessionID: string }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    for (const sessionID of sessionIDs) tasks.push({ scopeID, sessionID })
  }

  let done = 0
  let changed = 0
  for (const { scopeID, sessionID } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const path = StoragePath.sessionInfo(scope, sid)
    const info = await Storage.read<Record<string, unknown>>(path).catch(() => undefined)
    const workflow = asRecord(info?.workflow)
    const status = workflow?.status
    const terminal =
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "timed_out" ||
      status === "iteration_exhausted"

    if (info && workflow?.kind === "lightloop" && terminal) {
      const pluginOwner = asRecord(workflow.pluginOwner)
      const pluginId = asString(pluginOwner?.pluginId)
      const pluginGeneration = asString(pluginOwner?.pluginGeneration)
      const ownerScopeID = asString(pluginOwner?.scopeId)
      if (pluginOwner && pluginId && pluginGeneration && ownerScopeID) {
        const time = asRecord(info.time)
        await Storage.write(StoragePath.sessionLightLoopTerminal(scope, sid), {
          sessionID,
          status,
          instructions: asString(workflow.instructions) ?? "",
          pluginOwner: {
            pluginId,
            pluginGeneration,
            scopeId: ownerScopeID,
            ...(asString(pluginOwner.correlationId) ? { correlationId: asString(pluginOwner.correlationId) } : {}),
          },
          ...(asString(workflow.terminalError) ? { error: asString(workflow.terminalError) } : {}),
          ...(typeof workflow.terminalHookDeliveredAt === "number"
            ? { hookDeliveredAt: workflow.terminalHookDeliveredAt }
            : {}),
          ...(asString(workflow.terminalHookError) ? { hookError: asString(workflow.terminalHookError) } : {}),
          createdAt: typeof time?.updated === "number" ? time.updated : 0,
        })
      } else if (pluginOwner) {
        done++
        progress(done, tasks.length)
        continue
      }

      delete info.workflow
      await Storage.write(path, info)
      changed++
    }

    done++
    progress(done, tasks.length)
  }

  log.info("terminal Light Loop migration complete", { total: tasks.length, changed })
}

function migrateWorkflowMessageMetadata(metadata: Record<string, unknown>): {
  metadata: Record<string, unknown> | undefined
  changed: boolean
} {
  const original = JSON.stringify(metadata)
  const next: Record<string, unknown> = { ...metadata }
  let workflow: "plan" | "lightloop" | "lattice" | undefined

  if (metadata.planModeRequest === true) workflow = "plan"
  const workflowMode = metadata.workflowMode
  if (workflowMode === "plan" || workflowMode === "lattice") workflow = workflowMode
  if (workflowMode === "light_loop") workflow = "lightloop"

  const agent = asString(metadata.workflowModeAgent) ?? asString(metadata.planModeAgent)

  delete next.planModeRequest
  delete next.planModeAgent
  delete next.planModeWrapperVersion
  delete next.workflowMode
  delete next.workflowModeAgent
  delete next.workflowModeVersion

  if (workflow) {
    next.workflow = workflow
    next.workflowVersion = 1
  }
  if (agent) next.workflowAgent = agent

  const normalized = compact(next)
  return { metadata: normalized, changed: JSON.stringify(normalized) !== original }
}

async function migrateWorkflowMessageMetadataFields(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
  const tasks: Array<{ scopeID: string; sessionID: string; messageID: string }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    for (const sessionID of sessionIDs) {
      const messageIDs = await Storage.scan(
        StoragePath.sessionMessagesRoot(scope, Identifier.asSessionID(sessionID)),
      ).catch(() => [])
      for (const messageID of messageIDs) tasks.push({ scopeID, sessionID, messageID })
    }
  }

  if (tasks.length === 0) return

  let done = 0
  let changed = 0
  for (const { scopeID, sessionID, messageID } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const mid = Identifier.asMessageID(messageID)
    const path = StoragePath.messageInfo(scope, sid, mid)
    const info = await Storage.read<MessageV2.Info>(path).catch(() => undefined)
    if (info?.metadata) {
      const migrated = migrateWorkflowMessageMetadata(info.metadata as Record<string, unknown>)
      if (migrated.changed) {
        await Storage.write(path, {
          ...info,
          metadata: migrated.metadata,
        })
        changed++
      }
    }

    done++
    progress(done, tasks.length)
  }

  log.info("workflow message metadata migration complete", { total: tasks.length, changed })
}

export const migrations: Migration[] = [
  {
    domain: "session",
    id: "20260708-session-workflow-field",
    description: "Migrate workflow mode session fields and message metadata to canonical workflow shape",
    async up(progress) {
      await migrateSessionWorkflowFields(progress)
      progress(0, 0, 1)
      await migrateWorkflowMessageMetadataFields((current, total) => progress(current, total, 1))
    },
  },
  {
    domain: "session",
    id: "20260718-lightloop-instructions-field",
    description: "Migrate Light Loop task descriptions to canonical instructions",
    async up(progress) {
      await migrateLightloopInstructionsField(progress)
    },
  },
  {
    domain: "session",
    id: "20260723-migrate-terminal-lightloops",
    description: "Move terminal plugin Light Loop results out of the interactive workflow slot",
    async up(progress) {
      await migrateTerminalLightloops(progress)
    },
  },
]

export function registerSessionMigrations() {
  MigrationRegistry.register("workflows-session", migrations)
}
registerSessionMigrations()
