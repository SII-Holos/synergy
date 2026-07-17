/**
 * Native Clarus Navigation DTO builders.
 *
 * Produces public navigation snapshots with strict field allowlists,
 * connection status mapping, and Blueprint task priority ordering.
 * This module owns DTO mapping only — no events, no side effects.
 */

import type { ClarusProjectBindingV3, ClarusTaskBindingV4 } from "./schemas"
import type { ClarusRuntimeStatus } from "./runtime"

// ── Constants ─────────────────────────────────────────────────

/** Blueprint task priority ordering for navigation sorting. */
export const TASK_PRIORITY_ORDER: readonly string[] = [
  "needs_attention",
  "running",
  "submitting",
  "waiting",
  "submitted",
  "failed",
  "expired",
  "cancelled",
] as const

/** Blueprint public connection statuses. */
export const NAV_CONNECTION_STATUSES = [
  "disabled",
  "connected",
  "reconnecting",
  "sign_in_required",
  "sync_failed",
] as const

export type NavigationConnectionStatus = (typeof NAV_CONNECTION_STATUSES)[number]

const PRIORITY_RANK = new Map(TASK_PRIORITY_ORDER.map((s, i) => [s, i]))

// ── DTO types ────────────────────────────────────────────────

export interface NavigationProjectDto {
  projectId: string
  projectName: string | undefined
  projectSlug: string | undefined
  activeGroup: boolean
  projectStatus: string | undefined
  primaryAgent: string | null | undefined
  lastProjectActivityAt: number | undefined
  createdAt: number
  updatedAt: number
}

export interface NavigationTaskDto {
  taskId: string
  projectId: string
  sessionID: string
  title: string
  status: string
  resultState: string
  phase: string
  attempt: number
  deadlineAt: string | null | undefined
  contextHydration: string
  localContinuationEnabledAt: number | undefined
  resultRecordedAt: number | undefined
  runID: string
  subtaskID: string
  createdAt: number
  updatedAt: number
}

export interface NavigationSnapshot {
  connection: NavigationConnectionState
  projects: NavigationProjectDto[]
  tasks: NavigationTaskDto[]
}

export interface NavigationConnectionState {
  status: NavigationConnectionStatus
  agentId: string | null
  error?: string | undefined
}

// ── Mappers ──────────────────────────────────────────────────

/** Map internal Clarus runtime status to public navigation connection status. */
export function toNavigationConnectionStatus(runtimeStatus: ClarusRuntimeStatus): NavigationConnectionStatus {
  switch (runtimeStatus.status) {
    case "disabled":
      return "disabled"
    case "connected":
      return "connected"
    case "connecting":
    case "reconnecting":
      return "reconnecting"
    case "disconnected":
      return "sign_in_required"
    case "sync_failed":
    case "blocked":
      return "sync_failed"
  }
}

/** Map a project binding to the public navigation project DTO (strict allowlist). */
export function toNavigationProjectDto(binding: ClarusProjectBindingV3): NavigationProjectDto {
  return {
    projectId: binding.projectId,
    projectName: binding.projectName,
    projectSlug: binding.projectSlug,
    activeGroup: binding.lifecycle === "active",
    projectStatus: binding.projectStatus,
    primaryAgent: binding.primaryAgent,
    lastProjectActivityAt: binding.lastProjectActivityAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

/** Map a task binding to the public navigation task DTO (strict allowlist). */
export function toNavigationTaskDto(binding: ClarusTaskBindingV4): NavigationTaskDto {
  return {
    taskId: binding.taskId,
    projectId: binding.projectId,
    sessionID: binding.sessionID,
    title: binding.title,
    status: binding.status,
    resultState: binding.resultState,
    phase: binding.phase,
    attempt: binding.attempt,
    deadlineAt: binding.deadlineAt,
    contextHydration: binding.contextHydration,
    localContinuationEnabledAt: binding.localContinuationEnabledAt,
    resultRecordedAt: binding.resultRecordedAt,
    runID: binding.runID,
    subtaskID: binding.subtaskID,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}

// ── Sorting ──────────────────────────────────────────────────

/** Sort tasks by priority then by latest activity (updatedAt desc). */
export function sortTasksByPriority(tasks: NavigationTaskDto[]): NavigationTaskDto[] {
  return [...tasks].sort((a, b) => {
    const rankA = PRIORITY_RANK.get(a.status) ?? 99
    const rankB = PRIORITY_RANK.get(b.status) ?? 99
    if (rankA !== rankB) return rankA - rankB
    return b.updatedAt - a.updatedAt
  })
}
