/**
 * Native Clarus hierarchy model — pure functions for project/task grouping,
 * priority sorting, route construction, and stale-data retention.
 */
import type { SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { clarus as S, type AppMessageDescriptor } from "@/locales/messages"
import type { ClarusProject } from "@/context/clarus/clarus-model"
import { clarusProjectKey, clarusTaskKey } from "@/context/clarus/identity"

// ---------------------------------------------------------------------------
// Connection status constants
// ---------------------------------------------------------------------------

export const CLARUS_CONNECTION_STATUSES = [
  "disabled",
  "connected",
  "reconnecting",
  "sign_in_required",
  "sync_failed",
] as const

export type ClarusConnectionStatus = (typeof CLARUS_CONNECTION_STATUSES)[number]

export const CLARUS_STATUS_ICON: Record<ClarusConnectionStatus, SemanticIconTokenName> = {
  disabled: "clarus.status.disabled",
  connected: "clarus.status.connected",
  reconnecting: "clarus.status.reconnecting",
  sign_in_required: "clarus.status.sign_in_required",
  sync_failed: "clarus.status.sync_failed",
}

const CLARUS_CONNECTION_LABELS: Record<ClarusConnectionStatus, AppMessageDescriptor> = {
  connected: S.connectionConnected,
  reconnecting: S.connectionReconnecting,
  sign_in_required: S.connectionSignInRequired,
  sync_failed: S.connectionSyncFailed,
  disabled: S.connectionDisabled,
}

function sourceMessage(descriptor: AppMessageDescriptor): string {
  return descriptor.message ?? descriptor.id
}

export function connectionStatusLabel(
  status: ClarusConnectionStatus,
  translate: (descriptor: AppMessageDescriptor) => string = sourceMessage,
): string {
  return translate(CLARUS_CONNECTION_LABELS[status])
}

export function connectionStatusDetail(status: ClarusConnectionStatus, error?: string): string | undefined {
  return status === "sync_failed" ? error : undefined
}

const TASK_STATUS_LABELS: Record<string, AppMessageDescriptor> = {
  waiting: S.taskWaiting,
  running: S.taskRunning,
  needs_attention: S.taskNeedsAttention,
  submitting: S.taskSubmitting,
  submitted: S.taskSubmitted,
  failed: S.taskFailed,
  expired: S.taskExpired,
  cancelled: S.taskCancelled,
}

const RESULT_STATE_LABELS: Record<string, AppMessageDescriptor> = {
  not_dispatched: S.resultNotDispatched,
  prepared: S.resultPrepared,
  dispatched: S.resultDispatched,
  acknowledged: S.resultAcknowledged,
  ambiguous: S.resultAmbiguous,
  rejected: S.resultRejected,
  local_only: S.resultLocalOnly,
}

function fallbackStatusLabel(status: string): string {
  const label = status.replaceAll("_", " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function statusLabel(
  status: string,
  labels: Record<string, AppMessageDescriptor>,
  translate: (descriptor: AppMessageDescriptor) => string,
): string {
  const descriptor = labels[status]
  return descriptor ? translate(descriptor) : fallbackStatusLabel(status)
}

export function taskStatusLabel(
  status: string,
  resultState: string,
  translate: (descriptor: AppMessageDescriptor) => string = sourceMessage,
): string {
  const taskLabel = statusLabel(status, TASK_STATUS_LABELS, translate)
  return resultState === "idle"
    ? taskLabel
    : `${taskLabel} · ${statusLabel(resultState, RESULT_STATE_LABELS, translate)}`
}

// ---------------------------------------------------------------------------
// Task priority ordering
// ---------------------------------------------------------------------------

export const TASK_PRIORITY_ORDER: Record<string, number> = {
  needs_attention: 0,
  running: 1,
  submitting: 2,
  waiting: 3,
  submitted: 4,
  failed: 5,
  expired: 6,
  cancelled: 7,
}

// ---------------------------------------------------------------------------
// Empty project placeholder text
// ---------------------------------------------------------------------------

export const EMPTY_PROJECT_TASKS_TEXT = S.noTasks.message

// ---------------------------------------------------------------------------
// Task shape (minimal contract for sorting)
// ---------------------------------------------------------------------------

export interface TaskLike {
  agentId?: string
  projectId?: string
  taskId: string
  sessionID: string
  title: string
  status: string
  resultState: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Project shape (minimal contract for hierarchy building)
// ---------------------------------------------------------------------------

interface ProjectLike {
  agentId?: string
  projectId: string
  projectName: string
  lifecycle: "active" | "inactive"
  desiredSubscription: boolean
  lastProjectActivityAt: number
}

// ---------------------------------------------------------------------------
// Hierarchy output shape
// ---------------------------------------------------------------------------

export interface ClarusHierarchy {
  activeProjects: Array<{
    agentId?: string
    projectId: string
    projectName: string
    lifecycle: "active" | "inactive"
    lastProjectActivityAt: number
    tasks: TaskLike[]
  }>
  inactiveProjectsWithHistory: Array<{
    agentId?: string
    projectId: string
    projectName: string
    lifecycle: "active" | "inactive"
    lastProjectActivityAt: number
    tasks: TaskLike[]
  }>
  connectionStatus: ClarusConnectionStatus
}

// ---------------------------------------------------------------------------
// Open a task through the standard primary-session navigation path
// ---------------------------------------------------------------------------

export function activateTaskSession(
  task: Pick<TaskLike, "agentId" | "projectId" | "taskId" | "sessionID" | "status">,
  actions: {
    selectTask(taskKey: string): void
    navigateToSession(sessionID: string): void
  },
): void {
  if (!task.sessionID) throw new Error("sessionID must be non-empty")
  const taskKey = hierarchyTaskKey(task)
  actions.selectTask(taskKey)
  actions.navigateToSession(task.sessionID)
}

// ---------------------------------------------------------------------------
// Priority sort — stable across status bands, newest updatedAt first within band
// ---------------------------------------------------------------------------

export function sortTasksByPriority(tasks: TaskLike[]): TaskLike[] {
  return [...tasks].sort((a, b) => {
    const pa = TASK_PRIORITY_ORDER[a.status] ?? 99
    const pb = TASK_PRIORITY_ORDER[b.status] ?? 99
    if (pa !== pb) return pa - pb
    // Tie-break: higher priority = more recent activity
    return b.updatedAt - a.updatedAt
  })
}

// ---------------------------------------------------------------------------
// Build the active/inactive project hierarchy
// ---------------------------------------------------------------------------

export function hierarchyProjectKey(project: Pick<ProjectLike, "agentId" | "projectId">): string {
  return project.agentId ? clarusProjectKey(project.agentId, project.projectId) : project.projectId
}

export function hierarchyTaskKey(task: Pick<TaskLike, "agentId" | "projectId" | "taskId">): string {
  return task.agentId && task.projectId ? clarusTaskKey(task.agentId, task.projectId, task.taskId) : task.taskId
}

export function buildHierarchy(
  projects: ProjectLike[],
  projectTasks: Record<string, TaskLike[]>,
  connectionStatus: ClarusConnectionStatus,
): ClarusHierarchy {
  const activeProjects: ClarusHierarchy["activeProjects"] = []
  const inactiveProjectsWithHistory: ClarusHierarchy["inactiveProjectsWithHistory"] = []

  for (const project of projects) {
    const projectKey = hierarchyProjectKey(project)
    const tasks = projectTasks[projectKey] ? sortTasksByPriority(projectTasks[projectKey]) : []

    if (project.lifecycle === "active") {
      activeProjects.push({
        agentId: project.agentId,
        projectId: project.projectId,
        projectName: project.projectName,
        lifecycle: project.lifecycle,
        lastProjectActivityAt: project.lastProjectActivityAt,
        tasks,
      })
    } else if (tasks.length > 0) {
      // Inactive projects appear only when they have retained task history
      inactiveProjectsWithHistory.push({
        agentId: project.agentId,
        projectId: project.projectId,
        projectName: project.projectName,
        lifecycle: project.lifecycle,
        lastProjectActivityAt: project.lastProjectActivityAt,
        tasks,
      })
    }
  }

  return { activeProjects, inactiveProjectsWithHistory, connectionStatus }
}

export function buildClarusProjectHierarchy(
  projects: ClarusProject[],
  connectionStatus: ClarusConnectionStatus,
): ClarusHierarchy {
  return buildHierarchy(
    projects.map((project) => ({
      agentId: project.agentId,
      projectId: project.projectId,
      projectName: project.projectName ?? project.projectId,
      lifecycle: project.lifecycle,
      desiredSubscription: project.activeGroup,
      lastProjectActivityAt: project.lastProjectActivityAt ?? 0,
    })),
    Object.fromEntries(
      projects.map((project) => [clarusProjectKey(project.agentId, project.projectId), project.tasks]),
    ),
    connectionStatus,
  )
}

// ---------------------------------------------------------------------------
// Stale retention — prefer current, fall back to previous, null when both absent
// ---------------------------------------------------------------------------

export function retainStaleHierarchy(
  current: ClarusHierarchy | null,
  previous: ClarusHierarchy | null,
): ClarusHierarchy | null {
  if (current) return current
  return previous
}
