/**
 * Native Clarus frontend state model.
 * Holds the navigation snapshot, selection state, and composer lookup results.
 * Exposes a public action API and manages event subscriptions,
 * reconnect-version reactivity, and disposal.
 */

import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { clarusProjectKey } from "./identity"
import type {
  ClarusNavigationResponse,
  ClarusNavigationProjectDto,
  ClarusNavigationTaskDto,
  ClarusComposerUserItem,
  ClarusComposerProjectItem,
  ClarusComposerSubmitInput,
  ClarusComposerSubmitResponse,
} from "@ericsanchezok/synergy-sdk"

// ---------------------------------------------------------------------------
// Enriched project type — groups flat SDK tasks into their owning project
// ---------------------------------------------------------------------------

export interface ClarusProject {
  agentId: string
  projectId: string
  projectName?: string
  projectSlug?: string
  activeGroup: boolean
  lifecycle: "active" | "inactive"
  projectStatus?: string
  primaryAgent?: string | null
  lastProjectActivityAt?: number
  createdAt: number
  updatedAt: number
  tasks: ClarusNavigationTaskDto[]
}

// ---------------------------------------------------------------------------
// Navigation-snapshot shape stored in the reactive store
// ---------------------------------------------------------------------------

export interface ClarusNavigationSnapshot {
  connection: ClarusNavigationResponse["connection"]
  projects: ClarusProject[]
}

// ---------------------------------------------------------------------------
// Model dependencies — what the provider / test harness wires in
// ---------------------------------------------------------------------------

export interface ClarusModelDeps {
  navigation(): Promise<{ data: ClarusNavigationResponse }>
  lookupUsers(params?: { search?: string; limit?: number }): Promise<{
    data: ClarusComposerUserItem[]
  }>
  lookupProjects(params?: { search?: string; limit?: number }): Promise<{
    data: ClarusComposerProjectItem[]
  }>
  submit(params?: {
    clarusComposerSubmitInput?: ClarusComposerSubmitInput
  }): Promise<{ data: ClarusComposerSubmitResponse }>
  eventEmitter: {
    listen(handler: (event: { type: string; properties: Record<string, unknown> }) => void): () => void
  }
  onReconnectVersionChange(handler: () => void): () => void
}

// ---------------------------------------------------------------------------
// Reactive store shape
// ---------------------------------------------------------------------------

export interface ClarusStore {
  snapshot: ClarusNavigationSnapshot | undefined
  error: string | undefined
  stale: boolean
  loading: boolean
  selectedProjectKey: string | undefined
  selectedTaskKey: string | undefined
  composerUsers: ClarusComposerUserItem[]
  composerProjects: ClarusComposerProjectItem[]
}

// ---------------------------------------------------------------------------
// Public model interface
// ---------------------------------------------------------------------------

export interface ClarusModel {
  store: ClarusStore

  /** Fetch navigation snapshot for initial mount / explicit refresh. */
  refreshNavigation(): Promise<void>

  /**
   * Invalidate and refresh.  Coalesces rapid calls: at most one in-flight plus
   * one trailing.  Guards against stale responses via an internal request version.
   */
  invalidateAndRefresh(): Promise<void>

  /** Select a project by its composite navigation key. */
  selectProject(projectKey: string): void

  /** Select a task by its composite navigation key. */
  selectTask(taskKey: string): void

  /** Lookup composer users, capped at 5. */
  lookupUsers(search: string): Promise<void>

  /** Lookup composer projects, capped at 5. */
  lookupProjects(search: string): Promise<void>

  /**
   * Submit a composer message.  Calls the generated SDK exactly once.
   * Ambiguous errors surface to the caller — no auto-retry.
   */
  submitComposerMessage(input: ClarusComposerSubmitInput): Promise<ClarusComposerSubmitResponse>
}

// ---------------------------------------------------------------------------
// Helper — derive lifecycle string from activeGroup (for consumers that prefer
// string labels over booleans)
// ---------------------------------------------------------------------------

function lifecycle(active: boolean): "active" | "inactive" {
  return active ? "active" : "inactive"
}

// ---------------------------------------------------------------------------
// Helper — group flat SDK tasks into their owning projects
// ---------------------------------------------------------------------------

function groupTasksIntoProjects(
  projects: ClarusNavigationProjectDto[],
  tasks: ClarusNavigationTaskDto[],
): ClarusProject[] {
  const taskMap = new Map<string, ClarusNavigationTaskDto[]>()
  for (const task of tasks) {
    const key = clarusProjectKey(task.agentId, task.projectId)
    const list = taskMap.get(key)
    if (list) {
      list.push(task)
    } else {
      taskMap.set(key, [task])
    }
  }
  return projects.map((project) => ({
    agentId: project.agentId,
    projectId: project.projectId,
    projectName: project.projectName,
    projectSlug: project.projectSlug,
    activeGroup: project.activeGroup,
    lifecycle: lifecycle(project.activeGroup),
    projectStatus: project.projectStatus,
    primaryAgent: project.primaryAgent,
    lastProjectActivityAt: project.lastProjectActivityAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    tasks: taskMap.get(clarusProjectKey(project.agentId, project.projectId)) ?? [],
  }))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClarusModel(deps: ClarusModelDeps): ClarusModel {
  const [store, setStore] = createStore<ClarusStore>({
    snapshot: undefined,
    error: undefined,
    stale: false,
    loading: false,
    selectedProjectKey: undefined,
    selectedTaskKey: undefined,
    composerUsers: [],
    composerProjects: [],
  })

  // ---- request version guard ----
  let requestVersion = 0

  function nextVersion(): number {
    requestVersion += 1
    return requestVersion
  }

  // ---- coalescing state ----
  let inflightRefresh: Promise<void> | null = null
  let pendingTrailing = false

  // ---- core navigation fetch ----
  async function doRefresh(version: number): Promise<void> {
    setStore("loading", true)
    setStore("error", undefined)
    setStore("stale", false)
    try {
      const res = await deps.navigation()
      // Guard: only apply if this was the latest request
      if (version === requestVersion) {
        const snapshot: ClarusNavigationSnapshot = {
          connection: res.data.connection,
          projects: groupTasksIntoProjects(res.data.projects, res.data.tasks),
        }
        setStore("snapshot", snapshot)
        setStore("stale", res.data.connection.status === "reconnecting")
      }
    } catch (e: unknown) {
      // Only surface error for the latest request; older ones are ignored
      if (version === requestVersion) {
        const msg = e instanceof Error ? e.message : String(e)
        setStore("error", msg)
        setStore("stale", true)
        // Preserve last-good snapshot — do NOT clear it
      }
    } finally {
      // Only clear loading for the latest request
      if (version === requestVersion) {
        setStore("loading", false)
      }
    }
  }

  // ---- public actions ----

  async function refreshNavigation(): Promise<void> {
    const v = nextVersion()
    return doRefresh(v)
  }

  async function invalidateAndRefresh(): Promise<void> {
    if (inflightRefresh) {
      // Coalesce: mark trailing, return the *original* in-flight promise
      // so callers can await it directly
      pendingTrailing = true
      return inflightRefresh
    }

    const v = nextVersion()
    inflightRefresh = doRefresh(v)

    try {
      await inflightRefresh
    } finally {
      inflightRefresh = null
      if (pendingTrailing) {
        pendingTrailing = false
        // Fire a trailing refresh without blocking the outer promise
        const tv = nextVersion()
        inflightRefresh = doRefresh(tv).finally(() => {
          inflightRefresh = null
        })
      }
    }
  }

  function selectProject(projectKey: string): void {
    setStore("selectedProjectKey", projectKey)
  }

  function selectTask(taskKey: string): void {
    setStore("selectedTaskKey", taskKey)
  }

  async function lookupUsers(search: string): Promise<void> {
    const res = await deps.lookupUsers({ search, limit: 5 })
    setStore("composerUsers", res.data)
  }

  async function lookupProjects(search: string): Promise<void> {
    const res = await deps.lookupProjects({ search, limit: 5 })
    setStore("composerProjects", res.data)
  }

  async function submitComposerMessage(input: ClarusComposerSubmitInput): Promise<ClarusComposerSubmitResponse> {
    const res = await deps.submit({ clarusComposerSubmitInput: input })
    return res.data
  }

  // ---- event subscription & cleanup ----
  const unsubEvent = deps.eventEmitter.listen((event) => {
    if (event.type === "clarus.navigation.updated") {
      invalidateAndRefresh()
    }
  })
  onCleanup(unsubEvent)
  // ---- reconnectVersion tracking ----
  const unsubReconnect = deps.onReconnectVersionChange(() => {
    invalidateAndRefresh()
  })
  onCleanup(unsubReconnect)

  // ---- model object ----
  const model: ClarusModel = {
    store,
    refreshNavigation,
    invalidateAndRefresh,
    selectProject,
    selectTask,
    lookupUsers,
    lookupProjects,
    submitComposerMessage,
  }

  return model
}

// Re-export types used by tests and consumers
export type {
  ClarusNavigationProjectDto,
  ClarusNavigationTaskDto,
  ClarusComposerUserItem,
  ClarusComposerProjectItem,
  ClarusComposerSubmitInput,
  ClarusComposerSubmitResponse,
}

export { lifecycle }
