/**
 * Native Clarus hierarchy model — pure functions for project/task grouping,
 * priority sorting, route construction, and stale-data retention.
 */

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

export const EMPTY_PROJECT_TASKS_TEXT = "No tasks yet"

// ---------------------------------------------------------------------------
// Task shape (minimal contract for sorting)
// ---------------------------------------------------------------------------

interface TaskLike {
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
    projectId: string
    projectName: string
    lifecycle: "active" | "inactive"
    lastProjectActivityAt: number
    tasks: TaskLike[]
  }>
  inactiveProjectsWithHistory: Array<{
    projectId: string
    projectName: string
    lifecycle: "active" | "inactive"
    lastProjectActivityAt: number
    tasks: TaskLike[]
  }>
  connectionStatus: ClarusConnectionStatus
}

// ---------------------------------------------------------------------------
// Build a Home-scope session route
// ---------------------------------------------------------------------------

interface TaskRoute {
  scopeType: "home"
  sessionID: string
}

export function buildTaskRoute(sessionID: string): TaskRoute {
  if (!sessionID) {
    throw new Error("sessionID must be non-empty")
  }
  return { scopeType: "home", sessionID }
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

export function buildHierarchy(
  projects: ProjectLike[],
  projectTasks: Record<string, TaskLike[]>,
  connectionStatus: ClarusConnectionStatus,
): ClarusHierarchy {
  const activeProjects: ClarusHierarchy["activeProjects"] = []
  const inactiveProjectsWithHistory: ClarusHierarchy["inactiveProjectsWithHistory"] = []

  for (const project of projects) {
    const tasks = projectTasks[project.projectId] ? sortTasksByPriority(projectTasks[project.projectId]) : []

    if (project.lifecycle === "active") {
      activeProjects.push({
        projectId: project.projectId,
        projectName: project.projectName,
        lifecycle: project.lifecycle,
        lastProjectActivityAt: project.lastProjectActivityAt,
        tasks,
      })
    } else if (tasks.length > 0) {
      // Inactive projects appear only when they have retained task history
      inactiveProjectsWithHistory.push({
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
