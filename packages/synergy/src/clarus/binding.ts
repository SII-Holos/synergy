import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import {
  ClarusProjectBindingV3Schema,
  ClarusTaskBindingV4Schema,
  type ClarusProjectBindingV3,
  type ClarusTaskBindingV4,
} from "./schemas"
import type { ClarusResultStateV4, ClarusTaskStatusV4 } from "./schemas"
import { lockKey, validateSegment } from "./keys"

const log = Log.create({ service: "clarus-binding" })

async function writeReverseIndex(sessionID: string, agentId: string, projectId: string, taskId: string): Promise<void> {
  const indexKey = StoragePath.clarusSessionTaskIndex(sessionID)
  const existing = await Storage.read<Record<string, unknown>>(indexKey).catch(() => ({}))
  const entryKey = `${encodeURIComponent(agentId)}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`
  await Storage.write(indexKey, { ...existing, [entryKey]: true })
}

export namespace ClarusBindingStore {
  async function read(agentId: string, projectId: string): Promise<ClarusProjectBindingV3 | undefined> {
    const raw = await Storage.read<unknown>(StoragePath.clarusShardProjectBinding(agentId, projectId)).catch(
      () => undefined,
    )
    const parsed = ClarusProjectBindingV3Schema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  async function write(binding: ClarusProjectBindingV3): Promise<void> {
    await Storage.write(StoragePath.clarusShardProjectBinding(binding.agentId, binding.projectId), binding)
  }

  export async function readV3(agentId: string, projectId: string): Promise<ClarusProjectBindingV3 | undefined> {
    validateSegment(agentId)
    validateSegment(projectId)
    using _ = await Lock.write(lockKey("binding", agentId, projectId))
    return read(agentId, projectId)
  }

  export async function reconcileMetadata(input: {
    agentId: string
    projectId: string
    projectName: string
    projectSlug?: string
    projectStatus: string
    primaryAgent?: string | null
  }): Promise<ClarusProjectBindingV3 | undefined> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    using _ = await Lock.write(lockKey("binding", input.agentId, input.projectId))
    const binding = await read(input.agentId, input.projectId)
    if (!binding) return undefined

    const projectSlug = input.projectSlug ?? binding.projectSlug
    const primaryAgent = input.primaryAgent === undefined ? binding.primaryAgent : input.primaryAgent
    if (
      binding.projectName === input.projectName &&
      binding.projectSlug === projectSlug &&
      binding.projectStatus === input.projectStatus &&
      binding.primaryAgent === primaryAgent
    ) {
      return binding
    }

    const updated: ClarusProjectBindingV3 = {
      ...binding,
      projectName: input.projectName,
      projectSlug,
      projectStatus: input.projectStatus,
      primaryAgent,
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function get(agentId: string, projectId: string): Promise<{ state: "active" | "inactive" } | undefined> {
    const binding = await read(agentId, projectId)
    if (!binding) return undefined
    return { state: binding.lifecycle === "active" ? "active" : "inactive" }
  }

  export async function isActive(agentId: string, projectId: string): Promise<boolean> {
    const binding = await read(agentId, projectId)
    if (!binding) return false
    return binding.lifecycle === "active"
  }

  export async function ensureActive(agentId: string, projectId: string): Promise<ClarusProjectBindingV3> {
    validateSegment(agentId)
    validateSegment(projectId)
    const lock = lockKey("binding", agentId, projectId)
    using _ = await Lock.write(lock)

    const existing = await read(agentId, projectId)
    const now = Date.now()

    if (existing) {
      if (existing.lifecycle === "active") return existing
      const updated: ClarusProjectBindingV3 = {
        ...existing,
        lifecycle: "active",
        desiredSubscription: true,
        updatedAt: now,
      }
      await write(updated)
      return updated
    }

    const binding: ClarusProjectBindingV3 = {
      schemaVersion: 3,
      agentId,
      projectId,
      lifecycle: "active",
      desiredSubscription: true,
      createdAt: now,
      updatedAt: now,
    }
    await write(binding)
    return binding
  }

  export async function setInactive(agentId: string, projectId: string): Promise<void> {
    validateSegment(agentId)
    validateSegment(projectId)
    const lock = lockKey("binding", agentId, projectId)
    using _ = await Lock.write(lock)

    const existing = await read(agentId, projectId)
    const now = Date.now()

    if (!existing) {
      const binding: ClarusProjectBindingV3 = {
        schemaVersion: 3,
        agentId,
        projectId,
        lifecycle: "archived",
        desiredSubscription: false,
        createdAt: now,
        updatedAt: now,
      }
      await write(binding)
      return
    }

    if (existing.lifecycle === "archived") return
    const updated: ClarusProjectBindingV3 = {
      ...existing,
      lifecycle: "archived",
      desiredSubscription: false,
      updatedAt: now,
    }
    await write(updated)
  }

  export async function touchLastActivity(agentId: string, projectId: string, timestamp: number): Promise<void> {
    using _ = await Lock.write(lockKey("binding", agentId, projectId))
    const existing = await read(agentId, projectId)
    if (!existing) return
    if (existing.lastProjectActivityAt && existing.lastProjectActivityAt >= timestamp) return
    const updated: ClarusProjectBindingV3 = { ...existing, lastProjectActivityAt: timestamp, updatedAt: Date.now() }
    await write(updated)
  }

  export async function readBinding(agentId: string, projectId: string): Promise<ClarusProjectBindingV3 | undefined> {
    return read(agentId, projectId)
  }

  export async function listBindings(agentId: string): Promise<ClarusProjectBindingV3[]> {
    const root = StoragePath.clarusAgentProjectRoot(agentId)
    const keys = await Storage.scan(root)
    if (keys.length === 0) return []
    const storageKeys = keys.map((key) => [...root, key])
    const results = await Storage.readMany<unknown>(storageKeys)
    return results.flatMap((result, index) => {
      const parsed = ClarusProjectBindingV3Schema.safeParse(result)
      if (parsed.success) return [parsed.data]
      log.warn("ignored invalid Clarus project binding", {
        storageKey: storageKeys[index]?.join("/"),
        issues: parsed.error.issues,
      })
      return []
    })
  }

  const BINDING_PAGE_LIMIT_DEFAULT = 20
  const BINDING_PAGE_LIMIT_MAX = 100

  export interface BoundedBindingPage {
    items: ClarusProjectBindingV3[]
    nextCursor: string | null
  }

  /** List project bindings scoped to one agent with a hard read cap per call.
   *  Scans only the agent directory — bounded O(|agent projects|). */
  export async function listBindingsBounded(
    agentId: string,
    options: { limit?: number; cursor?: string },
  ): Promise<BoundedBindingPage> {
    const effectiveLimit = Math.min(Math.max(options.limit ?? BINDING_PAGE_LIMIT_DEFAULT, 1), BINDING_PAGE_LIMIT_MAX)
    const root = StoragePath.clarusAgentProjectRoot(agentId)
    const keys = await Storage.scan(root)

    let startIdx = 0
    if (options.cursor) {
      const cursorIdx = keys.indexOf(options.cursor)
      if (cursorIdx >= 0) startIdx = cursorIdx + 1
    }

    const scopedKeys = keys.slice(startIdx, startIdx + effectiveLimit)
    if (scopedKeys.length === 0) return { items: [], nextCursor: null }

    const storageKeys = scopedKeys.map((key) => [...root, key])
    const results = await Storage.readMany<unknown>(storageKeys)
    const items = results.flatMap((result, index) => {
      const parsed = ClarusProjectBindingV3Schema.safeParse(result)
      if (parsed.success) return [parsed.data]
      log.warn("ignored invalid Clarus project binding", {
        storageKey: storageKeys[index]?.join("/"),
        issues: parsed.error.issues,
      })
      return []
    })

    const nextCursor = startIdx + effectiveLimit < keys.length ? (scopedKeys[scopedKeys.length - 1] ?? null) : null

    return { items, nextCursor }
  }

  export async function reconcileBinding(input: {
    agentId: string
    projectId: string
    projectName: string
    projectSlug?: string
    projectStatus: string
    primaryAgent?: string | null
  }): Promise<ClarusProjectBindingV3> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    using _ = await Lock.write(lockKey("binding", input.agentId, input.projectId))
    const existing = await read(input.agentId, input.projectId)
    const now = Date.now()
    if (existing) {
      const projectSlug = input.projectSlug ?? existing.projectSlug
      const primaryAgent = input.primaryAgent === undefined ? existing.primaryAgent : input.primaryAgent
      if (
        existing.projectName === input.projectName &&
        existing.projectSlug === projectSlug &&
        existing.projectStatus === input.projectStatus &&
        existing.primaryAgent === primaryAgent &&
        existing.lifecycle === "active"
      ) {
        return existing
      }
      const updated: ClarusProjectBindingV3 = {
        ...existing,
        lifecycle: "active",
        desiredSubscription: true,
        projectName: input.projectName,
        projectSlug,
        projectStatus: input.projectStatus,
        primaryAgent,
        updatedAt: now,
      }
      await write(updated)
      return updated
    }
    const binding: ClarusProjectBindingV3 = {
      schemaVersion: 3,
      agentId: input.agentId,
      projectId: input.projectId,
      lifecycle: "active",
      desiredSubscription: true,
      projectName: input.projectName,
      projectSlug: input.projectSlug,
      projectStatus: input.projectStatus,
      primaryAgent: input.primaryAgent,
      messageCursor: null,
      createdAt: now,
      updatedAt: now,
    }
    await write(binding)
    return binding
  }

  export async function archiveMissing(agentId: string, knownProjectIds: Set<string>): Promise<void> {
    let cursor: string | undefined
    const MAX_ARCHIVE_MUTATIONS = 100
    const MAX_ARCHIVE_PAGES = 10
    let mutations = 0
    for (let page = 0; page < MAX_ARCHIVE_PAGES && mutations < MAX_ARCHIVE_MUTATIONS; page++) {
      const pageResult = await listBindingsBounded(agentId, { limit: BINDING_PAGE_LIMIT_MAX, cursor })
      if (pageResult.items.length === 0) break
      for (const binding of pageResult.items) {
        if (binding.lifecycle !== "active") continue
        if (knownProjectIds.has(binding.projectId)) continue
        if (mutations >= MAX_ARCHIVE_MUTATIONS) break
        using _ = await Lock.write(lockKey("binding", binding.agentId, binding.projectId))
        const fresh = await read(binding.agentId, binding.projectId)
        if (!fresh || fresh.lifecycle !== "active") continue
        if (knownProjectIds.has(fresh.projectId)) continue
        const updated: ClarusProjectBindingV3 = {
          ...fresh,
          lifecycle: "archived",
          desiredSubscription: false,
          updatedAt: Date.now(),
        }
        await write(updated)
        mutations++
      }
      if (!pageResult.nextCursor) break
      cursor = pageResult.nextCursor
    }
  }
}

export namespace ClarusTaskBindingStore {
  async function read(agentId: string, projectId: string, taskId: string): Promise<ClarusTaskBindingV4 | undefined> {
    const raw = await Storage.read<unknown>(StoragePath.clarusShardTaskBinding(agentId, projectId, taskId)).catch(
      () => undefined,
    )
    const parsed = ClarusTaskBindingV4Schema.safeParse(raw)
    return parsed.success ? parsed.data : undefined
  }

  async function write(binding: ClarusTaskBindingV4): Promise<void> {
    await Storage.write(StoragePath.clarusShardTaskBinding(binding.agentId, binding.projectId, binding.taskId), binding)
    await writeReverseIndex(binding.sessionID, binding.agentId, binding.projectId, binding.taskId)
  }

  export async function get(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    return read(agentId, projectId, taskId)
  }

  export async function ensureAssigned(
    agentId: string,
    projectId: string,
    taskId: string,
    sessionID: string,
    workspacePath: string,
    scopeID: string,
  ): Promise<ClarusTaskBindingV4> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    const lock = lockKey("task-binding", agentId, projectId, taskId)
    using _ = await Lock.write(lock)

    const existing = await read(agentId, projectId, taskId)
    if (existing) return existing

    const now = Date.now()
    const binding: ClarusTaskBindingV4 = {
      schemaVersion: 4,
      agentId,
      projectId,
      taskId,
      sessionID,
      workspacePath,
      scopeID,
      runID: "",
      subtaskID: "",
      phase: "",
      attempt: 0,
      title: taskId,
      taskInput: {},
      contextHydration: "unavailable",
      frozenAgent: "",
      assignmentState: "planned",
      assignmentInboxItemID: "",
      assignmentMessageID: "",
      status: "waiting",
      resultState: "idle",
      extendOutboxRequestIDs: [],
      createdAt: now,
      updatedAt: now,
    }
    await write(binding)
    return binding
  }

  export async function planAssignment(
    agentId: string,
    projectId: string,
    taskId: string,
    inboxItemID: string,
    messageID: string,
  ): Promise<ClarusTaskBindingV4> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) {
      throw new Error(
        `Clarus task binding not found for assignment plan: agentId=${agentId}, projectId=${projectId}, taskId=${taskId}`,
      )
    }
    if (existing.assignmentInboxItemID) {
      if (existing.assignmentInboxItemID !== inboxItemID) {
        throw new Error(
          `Clarus assignment ID conflict for task: ${taskId}. ` +
            `Existing inbox item ${existing.assignmentInboxItemID} conflicts with planned ${inboxItemID}`,
        )
      }
      return existing
    }
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      assignmentState: "planned",
      assignmentInboxItemID: inboxItemID,
      assignmentMessageID: messageID,
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markEnqueued(agentId: string, projectId: string, taskId: string): Promise<ClarusTaskBindingV4> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) {
      throw new Error(
        `Clarus task binding not found for enqueued mark: agentId=${agentId}, projectId=${projectId}, taskId=${taskId}`,
      )
    }
    if (existing.assignmentState === "enqueued") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      assignmentState: "enqueued",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markMaterialized(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) {
      throw new Error(
        `Clarus task binding not found for materialized mark: agentId=${agentId}, projectId=${projectId}, taskId=${taskId}`,
      )
    }
    if (existing.assignmentState === "materialized" || existing.assignmentState === "processing") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      assignmentState: "materialized",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markProcessing(
    agentId: string,
    projectId: string,
    taskId: string,
    lastCompletedAssistantMessageID?: string,
  ): Promise<ClarusTaskBindingV4> {
    validateSegment(agentId)
    validateSegment(projectId)
    validateSegment(taskId)
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) {
      throw new Error(
        `Clarus task binding not found for processing mark: agentId=${agentId}, projectId=${projectId}, taskId=${taskId}`,
      )
    }
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      assignmentState: "processing",
      status: "running",
      ...(lastCompletedAssistantMessageID ? { lastCompletedAssistantMessageID } : {}),
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markSubmitting(input: {
    agentId: string
    projectId: string
    taskId: string
    resultOutboxRequestID: string
    lastCompletedAssistantMessageID?: string
  }): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) return undefined
    if (existing.status === "submitting" || existing.status === "submitted") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "submitting",
      resultState: "prepared",
      resultOutboxRequestID: input.resultOutboxRequestID,
      ...(input.lastCompletedAssistantMessageID
        ? { lastCompletedAssistantMessageID: input.lastCompletedAssistantMessageID }
        : {}),
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markSubmitted(input: {
    agentId: string
    projectId: string
    taskId: string
  }): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) return undefined
    if (existing.status === "submitted") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "submitted",
      resultState: "dispatched",
      resultRecordedAt: Date.now(),
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markResultAcknowledged(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.resultState === "acknowledged" || existing.resultState === "local_only") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      resultState: "acknowledged",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markResultNotDispatched(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.resultState === "not_dispatched" || existing.resultState === "local_only") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "running",
      resultState: "not_dispatched",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markResultRejected(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.resultState === "rejected" || existing.resultState === "local_only") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "needs_attention",
      resultState: "rejected",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markResultAmbiguous(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.resultState === "ambiguous" || existing.resultState === "local_only") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "needs_attention",
      resultState: "ambiguous",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  /** List all task bindings for a project — scans only the project directory.
   *  Bounded O(|project tasks|). */
  export async function listTaskBindings(agentId: string, projectId: string): Promise<ClarusTaskBindingV4[]> {
    const root = StoragePath.clarusProjectTaskRoot(agentId, projectId)
    const keys = await Storage.scan(root)
    if (keys.length === 0) return []
    const storageKeys = keys.map((key) => [...root, key])
    const results = await Storage.readMany<unknown>(storageKeys)
    return results.flatMap((result, index) => {
      const parsed = ClarusTaskBindingV4Schema.safeParse(result)
      if (parsed.success) return [parsed.data]
      log.warn("ignored invalid Clarus task binding", {
        storageKey: storageKeys[index]?.join("/"),
        issues: parsed.error.issues,
      })
      return []
    })
  }

  const TASK_BINDING_PAGE_LIMIT_DEFAULT = 20
  const TASK_BINDING_PAGE_LIMIT_MAX = 100

  export interface BoundedTaskBindingPage {
    items: ClarusTaskBindingV4[]
    nextCursor: string | null
  }

  /** List task bindings scoped to one agent (and optionally one project) with
   *  a hard read cap per call. Project-scoped: scans only the project directory
   *  — bounded O(|project tasks|). Agent-scoped: scans only the agent's project
   *  directories then their task files — bounded O(|agent projects| × |project tasks per project|).
   *  Default limit 20, max 100. */
  export async function listTaskBindingsBounded(
    agentId: string,
    options: { projectId?: string; limit?: number; cursor?: string },
  ): Promise<BoundedTaskBindingPage> {
    const effectiveLimit = Math.min(
      Math.max(options.limit ?? TASK_BINDING_PAGE_LIMIT_DEFAULT, 1),
      TASK_BINDING_PAGE_LIMIT_MAX,
    )

    let allKeys: { skey: string; storageKey: string[] }[] = []
    if (options.projectId) {
      const root = StoragePath.clarusProjectTaskRoot(agentId, options.projectId)
      const keys = await Storage.scan(root)
      allKeys = keys.map((k) => ({ skey: k, storageKey: [...root, k] }))
    } else {
      const agentRoot = StoragePath.clarusAgentTaskRoot(agentId)
      const projectDirs = await Storage.scan(agentRoot)
      for (const projDir of projectDirs) {
        const projRoot = [...agentRoot, projDir]
        const taskKeys = await Storage.scan(projRoot)
        for (const tk of taskKeys) {
          allKeys.push({ skey: `${projDir}/${tk}`, storageKey: [...projRoot, tk] })
        }
      }
    }

    allKeys.sort((a, b) => a.skey.localeCompare(b.skey))

    let startIdx = 0
    if (options.cursor) {
      const cursorIdx = allKeys.findIndex((e) => e.skey === options.cursor)
      if (cursorIdx >= 0) startIdx = cursorIdx + 1
    }

    const scopedKeys = allKeys.slice(startIdx, startIdx + effectiveLimit)
    if (scopedKeys.length === 0) return { items: [], nextCursor: null }

    const storageKeys = scopedKeys.map((e) => e.storageKey)
    const results = await Storage.readMany<unknown>(storageKeys)
    const items = results.flatMap((result, index) => {
      const parsed = ClarusTaskBindingV4Schema.safeParse(result)
      if (parsed.success) return [parsed.data]
      log.warn("ignored invalid Clarus task binding", {
        storageKey: storageKeys[index]?.join("/"),
        issues: parsed.error.issues,
      })
      return []
    })

    const nextCursor =
      startIdx + effectiveLimit < allKeys.length ? (scopedKeys[scopedKeys.length - 1]?.skey ?? null) : null

    return { items, nextCursor }
  }

  export async function readV3(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    return read(agentId, projectId, taskId)
  }

  export async function updateAssignmentMetadata(input: {
    agentId: string
    projectId: string
    taskId: string
    runID: string
    phase: string
    subtaskID: string
    attempt: number
    deadlineAt?: string | null
    frozenAgent: string
    title: string
    taskInput: Record<string, unknown>
    contextHydration: "complete" | "partial" | "unavailable"
  }): Promise<ClarusTaskBindingV4> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    validateSegment(input.taskId)
    using _ = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) {
      throw new Error(`Clarus task binding not found: ${input.taskId}`)
    }
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      runID: input.runID,
      phase: input.phase,
      subtaskID: input.subtaskID,
      attempt: input.attempt,
      deadlineAt: input.deadlineAt ?? null,
      frozenAgent: input.frozenAgent,
      title: input.title,
      taskInput: input.taskInput,
      contextHydration: input.contextHydration,
      status: "running",
      assignmentState:
        existing.assignmentState === "planned" || existing.assignmentState === "enqueued"
          ? existing.assignmentState
          : "materialized",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function updateExtensionOutbox(
    agentId: string,
    projectId: string,
    taskId: string,
    requestID: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined

    const MAX_EXTEND_OUTBOX_REQUEST_IDS = 32
    let requestIDs = [...existing.extendOutboxRequestIDs, requestID]
    if (requestIDs.length > MAX_EXTEND_OUTBOX_REQUEST_IDS) {
      requestIDs = requestIDs.slice(requestIDs.length - MAX_EXTEND_OUTBOX_REQUEST_IDS)
    }
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      extendOutboxRequestIDs: requestIDs,
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function updateExtension(
    agentId: string,
    projectId: string,
    taskId: string,
    deadlineAt: string | null,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      deadlineAt,
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markCompleted(input: {
    agentId: string
    projectId: string
    taskId: string
  }): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) return undefined
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "submitted",
      resultState: "acknowledged",
      resultRecordedAt: existing.resultRecordedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function enableLocalContinuation(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.localContinuationEnabledAt) return undefined
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      localContinuationEnabledAt: Date.now(),
      resultState: "local_only",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function markNeedsAttention(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.status === "submitted" || existing.status === "cancelled" || existing.status === "expired")
      return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "needs_attention",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function revertSubmitting(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.status !== "submitting") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "needs_attention",
      resultState: "idle",
      resultOutboxRequestID: undefined,
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  export async function findBySessionID(sessionID: string): Promise<ClarusTaskBindingV4 | undefined> {
    const indexKey = StoragePath.clarusSessionTaskIndex(sessionID)
    const indexData = await Storage.read<Record<string, unknown>>(indexKey).catch(() => undefined)
    if (!indexData) return undefined
    const entries = Object.keys(indexData)
    if (entries.length === 0) return undefined
    // Return the first entry's binding
    const [agentId, projectId, taskId] = entries[0].split(":").map(decodeURIComponent)
    return read(agentId, projectId, taskId)
  }

  export async function expireTask(
    agentId: string,
    projectId: string,
    taskId: string,
  ): Promise<ClarusTaskBindingV4 | undefined> {
    using _ = await Lock.write(lockKey("task-binding", agentId, projectId, taskId))
    const existing = await read(agentId, projectId, taskId)
    if (!existing) return undefined
    if (existing.status === "expired") return existing
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      status: "expired",
      updatedAt: Date.now(),
    }
    await write(updated)
    return updated
  }

  /** Shared assignment materialization for live and backfill parity. Writes
   *  full run/phase/subtask/attempt/deadline/frozen-agent/task-input/context
   *  metadata and records a durable materializedAt marker before advancing
   *  the assignment state. */
  export async function materializeAssignment(input: {
    agentId: string
    projectId: string
    taskId: string
    runID: string
    phase: string
    subtaskID: string
    attempt: number
    deadlineAt?: string | null
    frozenAgent: string
    title: string
    taskInput: Record<string, unknown>
    contextHydration: "complete" | "partial" | "unavailable"
  }): Promise<ClarusTaskBindingV4> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    validateSegment(input.taskId)
    using _lk = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) {
      throw new Error(`Clarus task binding not found for materialization: ${input.taskId}`)
    }
    const now = Date.now()
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      runID: input.runID,
      phase: input.phase,
      subtaskID: input.subtaskID,
      attempt: input.attempt,
      deadlineAt: input.deadlineAt ?? existing.deadlineAt ?? null,
      frozenAgent: input.frozenAgent,
      title: input.title,
      taskInput: input.taskInput,
      contextHydration: input.contextHydration,
      status: "running",
      assignmentState: "materialized",
      materializedAt: now,
      updatedAt: now,
    }
    await write(updated)
    return updated
  }

  /** Acquire a durable task-session ownership claim. Must be called before the
   *  session is created. If no claim exists yet, sets one for this scope.
   *  If an unresolved claim exists for the same scope, returns existing (idempotent).
   *  If an unresolved claim exists for a different scope, throws.
   *  If a resolved claim exists, throws — the session already exists.
   *  Returns the binding with the claim attached. */
  export async function acquireOwnership(input: {
    agentId: string
    projectId: string
    taskId: string
    claimedByScopeID: string
  }): Promise<ClarusTaskBindingV4> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    validateSegment(input.taskId)
    using _lk = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) {
      throw new Error(`Clarus task binding not found for ownership: ${input.taskId}`)
    }
    // Resolved claim — session already exists
    if (existing.taskSessionOwnershipClaim?.resolvedAt !== undefined) {
      throw Object.assign(
        new Error(
          `Clarus task ${input.taskId} ownership already resolved by scope ${existing.taskSessionOwnershipClaim.claimedByScopeID}`,
        ),
        { code: "CLARUS_OWNERSHIP_RESOLVED" },
      )
    }
    // Unresolved claim — check scope
    if (existing.taskSessionOwnershipClaim) {
      if (existing.taskSessionOwnershipClaim.claimedByScopeID !== input.claimedByScopeID) {
        throw Object.assign(
          new Error(
            `Clarus task ${input.taskId} already claimed by scope ${existing.taskSessionOwnershipClaim.claimedByScopeID}`,
          ),
          { code: "CLARUS_OWNERSHIP_CONFLICT" },
        )
      }
      return existing
    }
    // No claim yet — acquire
    const now = Date.now()
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      taskSessionOwnershipClaim: {
        claimedByScopeID: input.claimedByScopeID,
        claimedAt: now,
      },
      updatedAt: now,
    }
    await write(updated)
    return updated
  }

  /** Resolve the ownership claim after session creation succeeds.
   *  Sets resolvedAt on the claim. Idempotent if already resolved.
   *  Throws if no claim exists. */
  export async function resolveOwnership(input: {
    agentId: string
    projectId: string
    taskId: string
  }): Promise<ClarusTaskBindingV4> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    validateSegment(input.taskId)
    using _lk = await Lock.write(lockKey("task-binding", input.agentId, input.projectId, input.taskId))
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) {
      throw new Error(`Clarus task binding not found for ownership resolve: ${input.taskId}`)
    }
    if (!existing.taskSessionOwnershipClaim) {
      throw Object.assign(new Error(`Clarus task ${input.taskId} has no ownership claim to resolve`), {
        code: "CLARUS_OWNERSHIP_NO_CLAIM",
      })
    }
    if (existing.taskSessionOwnershipClaim.resolvedAt !== undefined) return existing
    const now = Date.now()
    const updated: ClarusTaskBindingV4 = {
      ...existing,
      taskSessionOwnershipClaim: {
        ...existing.taskSessionOwnershipClaim,
        resolvedAt: now,
      },
      updatedAt: now,
    }
    await write(updated)
    return updated
  }

  /** Check whether a task can be recovered by this scope after a crash.
   *  Returns the binding if there is an unresolved claim for this scope
   *  (session creation was interrupted), undefined otherwise. */
  export async function recoverOwnership(input: {
    agentId: string
    projectId: string
    taskId: string
    claimedByScopeID: string
  }): Promise<ClarusTaskBindingV4 | undefined> {
    validateSegment(input.agentId)
    validateSegment(input.projectId)
    validateSegment(input.taskId)
    const existing = await read(input.agentId, input.projectId, input.taskId)
    if (!existing) return undefined
    const claim = existing.taskSessionOwnershipClaim
    if (!claim) return undefined
    // Resolved — session exists, not a crash recovery case
    if (claim.resolvedAt !== undefined) return undefined
    // Unresolved claim for our scope — recoverable
    if (claim.claimedByScopeID === input.claimedByScopeID) return existing
    return undefined
  }
}

/** Terminal result states — once reached, no further result transitions are allowed. */
export function isResultTerminal(state: ClarusResultStateV4): boolean {
  return state === "acknowledged" || state === "rejected" || state === "ambiguous" || state === "local_only"
}

/** Terminal task statuses — task is complete or permanently stopped. */
export function isStatusTerminal(status: ClarusTaskStatusV4): boolean {
  return status === "submitted" || status === "cancelled" || status === "failed" || status === "expired"
}
