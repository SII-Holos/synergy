import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { MigrationRegistry } from "@/migration/registry"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import {
  ClarusBindingSchema,
  ClarusProjectBindingV3Schema,
  ClarusTaskBindingSchema,
  ClarusTaskBindingV4Schema,
  ClarusOutboxRecordV2,
  ClarusOutboxRecordV1,
  ClarusProjectActivitySchema,
  upgradeBindingV1ToV3,
  upgradeBindingV2ToV3,
  upgradeTaskBindingV1ToV4,
  upgradeTaskBindingV2ToV4,
  upgradeTaskBindingV3ToV4,
  upgradeOutboxV1ToV2,
} from "./schemas"
import type { Migration } from "@/migration/types"
import type { Info as SessionInfo } from "@/session/types"

/** Deterministic deep equality for binding objects — stringifies with sorted keys.
 *  Used to verify readback content matches the intended source before deleting legacy data. */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return (obj as unknown[]).map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

function deepEqualBindings(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}
const log = Log.create({ service: "clarus.migration" })

async function archiveLegacySession(sessionID: string): Promise<void> {
  try {
    const indexed = await Storage.read<{ scopeID: string }>(
      StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
    ).catch(() => undefined)
    if (!indexed) {
      log.warn("legacy project session index not found, skipping archive", { sessionID })
      return
    }
    const scopeID = Identifier.asScopeID(indexed.scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const infoPath = StoragePath.sessionInfo(scopeID, sid)
    const info = await Storage.read<SessionInfo>(infoPath).catch(() => undefined)
    if (!info) {
      log.warn("legacy project session info not found, skipping archive", { sessionID })
      return
    }
    if (info.time?.archived) return // already archived

    const now = Date.now()
    await Storage.write(infoPath, {
      ...info,
      pinned: 0,
      time: { ...info.time, archived: now },
    })
    log.info("archived legacy project session", { sessionID, scopeID })
  } catch (err) {
    log.warn("failed to archive legacy project session", { sessionID, error: String(err) })
  }
}

async function resolveTaskResultState(
  outboxRequestID: string,
  identity: { agentId: string; projectId: string; taskId: string; runID: string; subtaskID: string },
): Promise<"acknowledged" | "ambiguous" | "rejected" | "local_only"> {
  const raw = await Storage.read<unknown>(StoragePath.clarusOutboxRequestKey(outboxRequestID)).catch(() => undefined)
  if (!raw || typeof raw !== "object") return "local_only"

  const matches = (record: {
    action: string
    agentId: string
    projectId: string
    taskId?: string
    runId?: string
    subtaskId?: string
  }) =>
    record.action === "task_result" &&
    record.agentId === identity.agentId &&
    record.projectId === identity.projectId &&
    record.taskId === identity.taskId &&
    (record.runId === undefined || record.runId === identity.runID) &&
    (record.subtaskId === undefined || record.subtaskId === identity.subtaskID)

  const v2Parsed = ClarusOutboxRecordV2.safeParse(raw)
  if (v2Parsed.success) {
    const record = v2Parsed.data
    if (!matches(record)) return "local_only"
    if (record.state === "acknowledged") return "acknowledged"
    if (record.state === "ambiguous") return "ambiguous"
    if (record.state === "rejected") return "rejected"
    return "local_only"
  }

  const v1Parsed = ClarusOutboxRecordV1.safeParse(raw)
  if (v1Parsed.success) {
    const record = v1Parsed.data
    if (!matches(record)) return "local_only"
    if (record.state === "acknowledged") return "acknowledged"
    if (record.state === "ambiguous") return "ambiguous"
    if (record.state === "rejected") return "rejected"
  }

  return "local_only"
}

/** Read the legacy _materialized sidecar marker and return its timestamp, or undefined. */
async function readMaterializedSidcar(pathPrefix: string[]): Promise<number | undefined> {
  const markerKey = [...pathPrefix, "_materialized"]
  const marker = await Storage.read<{ materializedAt: number }>(markerKey).catch(() => undefined)
  return marker?.materializedAt
}

/** Clean up the legacy _materialized sidecar if it exists. */
async function cleanupMaterializedSidcar(pathPrefix: string[]): Promise<void> {
  const markerKey = [...pathPrefix, "_materialized"]
  await Storage.remove(markerKey).catch(() => {})
}

async function upgradeProjectBindings(progress?: (current: number, total: number) => void): Promise<number> {
  const keys = await Storage.scan(StoragePath.clarusBindingsRoot())
  let upgraded = 0
  if (keys.length === 0) {
    progress?.(0, 0)
    return 0
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const path = [...StoragePath.clarusBindingsRoot(), key]
    const raw = await Storage.read<unknown>(path).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      progress?.(i + 1, keys.length)
      continue
    }

    const v3Parsed = ClarusProjectBindingV3Schema.safeParse(raw)
    if (v3Parsed.success) {
      progress?.(i + 1, keys.length)
      continue
    }

    const parsed = ClarusBindingSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn("skipping unparseable project binding during migration", {
        key,
        issues: parsed.error.issues,
      })
      progress?.(i + 1, keys.length)
      continue
    }
    const binding = parsed.data

    // A1: Capture legacy projectSessionID before upgrade
    if ("projectSessionID" in binding && typeof binding.projectSessionID === "string" && binding.projectSessionID) {
      await archiveLegacySession(binding.projectSessionID)
    }

    const v3 = binding.schemaVersion === 1 ? upgradeBindingV1ToV3(binding) : upgradeBindingV2ToV3(binding)
    await Storage.write(path, v3)
    upgraded++
    progress?.(i + 1, keys.length)
  }
  return upgraded
}

async function upgradeTaskBindings(progress?: (current: number, total: number) => void): Promise<number> {
  const root = [...StoragePath.clarusBindingsRoot(), "tasks"]
  const keys = await Storage.scan(root)
  let upgraded = 0
  if (keys.length === 0) {
    progress?.(0, 0)
    return 0
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const path = [...root, key]
    const raw = await Storage.read<unknown>(path).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      progress?.(i + 1, keys.length)
      continue
    }

    const v4Parsed = ClarusTaskBindingV4Schema.safeParse(raw)
    if (v4Parsed.success) {
      // V4 already canonical — check for legacy sidecar to migrate
      progress?.(i + 1, keys.length)
      continue
    }

    const parsed = ClarusTaskBindingSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn("skipping unparseable task binding during migration", {
        key,
        issues: parsed.error.issues,
      })
      progress?.(i + 1, keys.length)
      continue
    }
    const binding = parsed.data

    let v4
    switch (binding.schemaVersion) {
      case 1:
        v4 = upgradeTaskBindingV1ToV4(binding)
        break
      case 2:
        v4 = upgradeTaskBindingV2ToV4(binding)
        break
      case 3:
        v4 = upgradeTaskBindingV3ToV4(binding)
        break
      default:
        continue
    }

    // B: Resolve outbox evidence for completed/submitted tasks
    if (v4.resultOutboxRequestID) {
      const evidence = await resolveTaskResultState(v4.resultOutboxRequestID, v4)
      v4.resultState = evidence !== "local_only" ? evidence : "idle"
      if (evidence === "acknowledged") {
        v4.status = "submitted"
      } else if (evidence === "rejected" || evidence === "ambiguous") {
        v4.status = "needs_attention"
      } else {
        // local_only: outbox record missing or identity mismatch → needs_attention
        v4.status = "needs_attention"
      }
    }

    await Storage.write(path, v4)
    upgraded++
    progress?.(i + 1, keys.length)
  }
  return upgraded
}

async function upgradeOutboxRecords(progress?: (current: number, total: number) => void): Promise<number> {
  const keys = await Storage.scan(StoragePath.clarusOutboxRoot())
  let upgraded = 0
  if (keys.length === 0) {
    progress?.(0, 0)
    return 0
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const path = [...StoragePath.clarusOutboxRoot(), key]
    const raw = await Storage.read<unknown>(path).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      progress?.(i + 1, keys.length)
      continue
    }

    const parsed = (await import("./schemas")).ClarusOutboxRecordSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn("skipping unparseable outbox record during migration", {
        key,
        issues: parsed.error.issues,
      })
      progress?.(i + 1, keys.length)
      continue
    }
    const record = parsed.data
    if ("schemaVersion" in record && record.schemaVersion === 2) {
      progress?.(i + 1, keys.length)
      continue
    }

    const v1Parsed = (await import("./schemas")).ClarusOutboxRecordV1.safeParse(record)
    if (!v1Parsed.success) {
      progress?.(i + 1, keys.length)
      continue
    }

    const v2 = upgradeOutboxV1ToV2(v1Parsed.data)
    await Storage.write(path, v2)
    upgraded++
    progress?.(i + 1, keys.length)
  }
  return upgraded
}

async function rebuildNavIndexes(progress?: (current: number, total: number) => void): Promise<number> {
  const { SessionNav } = await import("@/session/nav")
  await SessionNav.rebuildAllNavIndexes(progress)
  return 0
}

async function rebuildReverseIndex(progress?: (current: number, total: number) => void): Promise<number> {
  const root = [...StoragePath.clarusBindingsRoot(), "tasks"]
  const keys = await Storage.scan(root)
  if (keys.length === 0) {
    progress?.(0, 0)
    return 0
  }

  let rebuilt = 0
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const path = [...root, key]
    const raw = await Storage.read<unknown>(path).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      progress?.(i + 1, keys.length)
      continue
    }

    const parsed = ClarusTaskBindingV4Schema.safeParse(raw)
    if (!parsed.success) {
      progress?.(i + 1, keys.length)
      continue
    }

    const binding = parsed.data
    const indexKey = StoragePath.clarusSessionTaskIndex(binding.sessionID)
    const existing = await Storage.read<Record<string, unknown>>(indexKey).catch(() => ({}))
    const entryKey = `${encodeURIComponent(binding.agentId)}:${encodeURIComponent(binding.projectId)}:${encodeURIComponent(binding.taskId)}`
    await Storage.write(indexKey, { ...existing, [entryKey]: true })
    rebuilt++
    progress?.(i + 1, keys.length)
  }
  return rebuilt
}
async function migrateMaterializedSidcars(progress?: (current: number, total: number) => void): Promise<number> {
  const root = [...StoragePath.clarusBindingsRoot(), "tasks"]
  const keys = await Storage.scan(root)
  let migrated = 0
  if (keys.length === 0) {
    progress?.(0, 0)
    return 0
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const path = [...root, key]
    const raw = await Storage.read<unknown>(path).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      progress?.(i + 1, keys.length)
      continue
    }

    const v4Parsed = ClarusTaskBindingV4Schema.safeParse(raw)
    if (!v4Parsed.success) {
      progress?.(i + 1, keys.length)
      continue
    }
    const binding = v4Parsed.data

    // Already has canonical materializedAt — skip (but still clean up sidecar)
    if (binding.materializedAt !== undefined) {
      await cleanupMaterializedSidcar(path)
      progress?.(i + 1, keys.length)
      continue
    }

    // Try to read materializedAt from legacy sidecar
    const sidecarAt = await readMaterializedSidcar(path)
    if (sidecarAt !== undefined) {
      const updated = { ...binding, materializedAt: sidecarAt, updatedAt: Date.now() }
      await Storage.write(path, updated)
      await cleanupMaterializedSidcar(path)
      migrated++
    }

    progress?.(i + 1, keys.length)
  }
  return migrated
}

export async function migrateBindingSharding(progress?: (current: number, total: number) => void): Promise<{
  projectMigrated: number
  projectSkipped: number
  projectCollisions: number
  projectMalformed: number
  taskMigrated: number
  taskSkipped: number
  taskCollisions: number
  taskMalformed: number
}> {
  let projectMigrated = 0
  let projectSkipped = 0
  let projectCollisions = 0
  let projectMalformed = 0
  let taskMigrated = 0
  let taskSkipped = 0
  let taskCollisions = 0
  let taskMalformed = 0

  // ---- Phase 1: migrate project bindings from flat to sharded ----
  const flatBindingsRoot = StoragePath.clarusBindingsRoot() // ["clarus", "bindings"]
  const flatBindingKeys = await Storage.scan(flatBindingsRoot)

  for (let i = 0; i < flatBindingKeys.length; i++) {
    const flatKey = flatBindingKeys[i]
    // Legacy project key format: encodedAgent:encodedProject (2 colon-separated parts)
    const colonCount = flatKey.split(":").length - 1
    if (colonCount !== 1) {
      // Not a legacy flat binding (could be a new agent shard or tasks directory)
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }

    const flatPath = [...flatBindingsRoot, flatKey]
    const raw = await Storage.read<unknown>(flatPath).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      projectMalformed++
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }

    const parsed = ClarusProjectBindingV3Schema.safeParse(raw)
    if (!parsed.success) {
      log.warn("skipping unparseable project binding during shard migration", {
        key: flatKey,
        issues: parsed.error.issues,
      })
      projectMalformed++
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }
    const binding = parsed.data

    const canonicalPath = StoragePath.clarusShardProjectBinding(binding.agentId, binding.projectId)

    // Check if canonical already exists
    const existing = await Storage.read<unknown>(canonicalPath).catch(() => undefined)
    if (existing) {
      const existingParsed = ClarusProjectBindingV3Schema.safeParse(existing)
      if (existingParsed.success) {
        // Already has canonical — verify identity AND content match
        if (existingParsed.data.agentId === binding.agentId && existingParsed.data.projectId === binding.projectId) {
          if (deepEqualBindings(existingParsed.data, binding)) {
            // Identical content — clean up legacy
            await Storage.remove(flatPath)
            projectSkipped++
            progress?.(i + 1, flatBindingKeys.length)
            continue
          }
          // Same identity, different content — collision, not cleanup
          log.warn("project binding shard collision (same identity, different content), preserving legacy", {
            canonicalAgent: existingParsed.data.agentId,
            canonicalProject: existingParsed.data.projectId,
            legacyAgent: binding.agentId,
            legacyProject: binding.projectId,
          })
          projectCollisions++
          progress?.(i + 1, flatBindingKeys.length)
          continue
        }
        // Canonical occupied by different binding — collision
        log.warn("project binding shard collision (cross-identity), preserving legacy", {
          flatKey,
          canonicalAgent: existingParsed.data.agentId,
          canonicalProject: existingParsed.data.projectId,
          legacyAgent: binding.agentId,
          legacyProject: binding.projectId,
        })
        projectCollisions++
        progress?.(i + 1, flatBindingKeys.length)
        continue
      }
    }

    // Write canonical first, then verify (parse + content equality), then delete legacy
    await Storage.write(canonicalPath, binding)
    const verified = await Storage.read<unknown>(canonicalPath).catch(() => undefined)
    if (!verified) {
      log.warn("project binding shard write missing on readback, preserving legacy")
      projectMalformed++
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }

    const verifiedParsed = ClarusProjectBindingV3Schema.safeParse(verified)
    if (!verifiedParsed.success) {
      log.warn("project binding shard write malformed on readback, preserving legacy")
      projectMalformed++
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }

    if (!deepEqualBindings(binding, verifiedParsed.data)) {
      log.warn("project binding shard write content mismatch on readback, preserving legacy")
      projectMalformed++
      progress?.(i + 1, flatBindingKeys.length)
      continue
    }

    await Storage.remove(flatPath)
    projectMigrated++
    progress?.(i + 1, flatBindingKeys.length)
  }

  // ---- Phase 2: migrate task bindings from flat to sharded ----
  const flatTasksRoot = [...StoragePath.clarusBindingsRoot(), "tasks"]
  const flatTaskKeys = await Storage.scan(flatTasksRoot)

  for (let i = 0; i < flatTaskKeys.length; i++) {
    const flatKey = flatTaskKeys[i]
    // Legacy task key format: encodedAgent:encodedProject:encodedTask
    const colonIdx = flatKey.indexOf(":")
    if (colonIdx === -1) {
      // Not a legacy flat binding (could be a new agent shard directory)
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }

    const flatPath = [...flatTasksRoot, flatKey]
    const raw = await Storage.read<unknown>(flatPath).catch(() => undefined)
    if (!raw || typeof raw !== "object") {
      taskMalformed++
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }

    const parsed = ClarusTaskBindingV4Schema.safeParse(raw)
    if (!parsed.success) {
      log.warn("skipping unparseable task binding during shard migration", {
        key: flatKey,
        issues: parsed.error.issues,
      })
      taskMalformed++
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }
    const binding = parsed.data

    const canonicalPath = StoragePath.clarusShardTaskBinding(binding.agentId, binding.projectId, binding.taskId)

    // Check if canonical already exists
    const existing = await Storage.read<unknown>(canonicalPath).catch(() => undefined)
    if (existing) {
      const existingParsed = ClarusTaskBindingV4Schema.safeParse(existing)
      if (existingParsed.success) {
        // Already has canonical — verify identity AND content match
        if (
          existingParsed.data.agentId === binding.agentId &&
          existingParsed.data.projectId === binding.projectId &&
          existingParsed.data.taskId === binding.taskId
        ) {
          if (deepEqualBindings(existingParsed.data, binding)) {
            // Identical content — clean up legacy
            await Storage.remove(flatPath)
            taskSkipped++
            progress?.(i + 1, flatTaskKeys.length)
            continue
          }
          // Same identity, different content — collision, not cleanup
          log.warn("task binding shard collision (same identity, different content), preserving legacy", {
            canonicalAgent: existingParsed.data.agentId,
            canonicalTask: existingParsed.data.taskId,
            legacyAgent: binding.agentId,
            legacyTask: binding.taskId,
          })
          taskCollisions++
          progress?.(i + 1, flatTaskKeys.length)
          continue
        }
        // Canonical occupied by different binding — collision
        log.warn("task binding shard collision (cross-identity), preserving legacy", {
          flatKey,
          canonicalAgent: existingParsed.data.agentId,
          canonicalTask: existingParsed.data.taskId,
          legacyAgent: binding.agentId,
          legacyTask: binding.taskId,
        })
        taskCollisions++
        progress?.(i + 1, flatTaskKeys.length)
        continue
      }
    }

    // Write canonical first, then verify (parse + content equality), then delete legacy
    await Storage.write(canonicalPath, binding)
    const verified = await Storage.read<unknown>(canonicalPath).catch(() => undefined)
    if (!verified) {
      log.warn("task binding shard write missing on readback, preserving legacy")
      taskMalformed++
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }

    const verifiedParsed = ClarusTaskBindingV4Schema.safeParse(verified)
    if (!verifiedParsed.success) {
      log.warn("task binding shard write malformed on readback, preserving legacy")
      taskMalformed++
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }

    if (!deepEqualBindings(binding, verifiedParsed.data)) {
      log.warn("task binding shard write content mismatch on readback, preserving legacy")
      taskMalformed++
      progress?.(i + 1, flatTaskKeys.length)
      continue
    }

    await Storage.remove(flatPath)
    taskMigrated++
    progress?.(i + 1, flatTaskKeys.length)
  }

  return {
    projectMigrated,
    projectSkipped,
    projectCollisions,
    projectMalformed,
    taskMigrated,
    taskSkipped,
    taskCollisions,
    taskMalformed,
  }
}

export async function migrateActivityTimelineIndex(progress?: (current: number, total: number) => void): Promise<{
  indexed: number
  skipped: number
  malformed: number
}> {
  const ACTIVITY_TS_PAD = 16
  const ACTIVITY_SORT_SEP = "--"
  function buildSortKey(receivedAt: number, messageId: string): string {
    return `${String(receivedAt).padStart(ACTIVITY_TS_PAD, "0")}${ACTIVITY_SORT_SEP}${encodeURIComponent(messageId)}`
  }

  let indexed = 0
  let skipped = 0
  let malformed = 0

  const activityRoot = StoragePath.clarusProjectActivityRoot() // ["clarus", "activity"]
  const agentDirs = await Storage.scan(activityRoot)
  if (agentDirs.length === 0) {
    progress?.(0, 0)
    return { indexed, skipped, malformed }
  }

  let processed = 0
  // Count total messageIds first for progress reporting.
  let totalMessages = 0
  for (const agentEnc of agentDirs) {
    const projectDirs = await Storage.scan([...activityRoot, agentEnc])
    for (const projectEnc of projectDirs) {
      const messageKeys = await Storage.scan([...activityRoot, agentEnc, projectEnc])
      totalMessages += messageKeys.length
    }
  }

  if (totalMessages === 0) {
    progress?.(0, 0)
    return { indexed, skipped, malformed }
  }

  for (const agentEnc of agentDirs) {
    const projectDirs = await Storage.scan([...activityRoot, agentEnc])
    for (const projectEnc of projectDirs) {
      const messageKeys = await Storage.scan([...activityRoot, agentEnc, projectEnc])
      const canonicalPrefix = [...activityRoot, agentEnc, projectEnc]

      for (const messageKey of messageKeys) {
        // Read canonical activity record.
        const raw = await Storage.read<unknown>([...canonicalPrefix, messageKey]).catch(() => undefined)
        if (!raw || typeof raw !== "object") {
          malformed++
          processed++
          progress?.(processed, totalMessages)
          continue
        }

        const parsed = ClarusProjectActivitySchema.safeParse(raw)
        if (!parsed.success) {
          log.warn("skipping unparseable activity record during timeline migration", {
            path: `${canonicalPrefix.join("/")}/${messageKey}`,
            issues: parsed.error.issues,
          })
          malformed++
          processed++
          progress?.(processed, totalMessages)
          continue
        }

        const activity = parsed.data
        const timelinePrefix = StoragePath.clarusActivityTimelineIndex(activity.agentId, activity.projectId)
        const sortKey = buildSortKey(activity.receivedAt, activity.messageId)

        // Check if this index entry already exists (idempotent re-run).
        const existingIndexEntry = await Storage.read<unknown>([...timelinePrefix, sortKey]).catch(() => undefined)
        if (existingIndexEntry) {
          skipped++
          processed++
          progress?.(processed, totalMessages)
          continue
        }

        // Clean up any stale index entries for this messageId (different receivedAt).
        const existingKeys = await Storage.scan(timelinePrefix)
        for (const key of existingKeys) {
          // Parse out the messageId from the sortKey and check match.
          const sepIdx = key.indexOf(ACTIVITY_SORT_SEP)
          if (sepIdx === -1) continue
          const keyMessageId = decodeURIComponent(key.slice(sepIdx + ACTIVITY_SORT_SEP.length))
          if (keyMessageId === activity.messageId) {
            await Storage.remove([...timelinePrefix, key])
          }
        }

        // Write the new index entry.
        await Storage.write([...timelinePrefix, sortKey], { messageId: activity.messageId })
        indexed++
        processed++
        progress?.(processed, totalMessages)
      }
    }
  }

  return { indexed, skipped, malformed }
}

export const clarusMigrations: Migration[] = [
  {
    id: "20260715-clarus-v4-forward",
    description: "Upgrade Clarus project bindings to V3, task bindings to V4, outbox to V2, rebuild reverse indexes",
    domain: "clarus",
    async up(progress) {
      await upgradeOutboxRecords(progress)
      const projectUpgraded = await upgradeProjectBindings(progress)
      const taskUpgraded = await upgradeTaskBindings(progress)
      const sidecarMigrated = await migrateMaterializedSidcars(progress)
      const reverseRebuilt = await rebuildReverseIndex(progress)
      await rebuildNavIndexes(progress)
      log.info("clarus v4 forward migration complete", {
        projectUpgraded,
        taskUpgraded,
        sidecarMigrated,
        reverseRebuilt,
      })
    },
  },
  {
    id: "20260715-clarus-binding-sharding",
    description: "Shard Clarus project/task bindings from flat to agent/project-scoped canonical paths",
    domain: "clarus",
    dependsOn: ["20260715-clarus-v4-forward"],
    async up(progress) {
      const stats = await migrateBindingSharding(progress)
      log.info("clarus binding sharding migration complete", stats)
    },
  },
  {
    id: "20260715-clarus-activity-timeline-index",
    description: "Build chronological timeline index for Clarus project activity from existing canonical records",
    domain: "clarus",
    dependsOn: ["20260715-clarus-binding-sharding"],
    async up(progress) {
      const stats = await migrateActivityTimelineIndex(progress)
      log.info("clarus activity timeline index migration complete", stats)
    },
  },
]

MigrationRegistry.register("clarus", clarusMigrations)
