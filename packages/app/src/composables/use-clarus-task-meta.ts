/**
 * Clarus task meta composable.
 *
 * Derives a ClarusTaskComposerState from a session endpoint and task binding
 * snapshot, using the pure task-composer-lifecycle model underneath.
 */
import { composeTaskLifecycle } from "@/components/clarus/task-composer-lifecycle"
import type {
  ClarusTaskStatus,
  ClarusTaskResultState,
  ComposerLifecycleState,
} from "@/components/clarus/task-composer-lifecycle"

import type { SessionEndpoint } from "@ericsanchezok/synergy-sdk"
// Input types
// ---------------------------------------------------------------------------

export interface ClarusTaskBindingSnapshot {
  status: ClarusTaskStatus
  resultState: ClarusTaskResultState
  title: string
  phase: string
  attempt: number
  localContinuationEnabledAt?: number
}

export interface ClarusTaskEndpointSnapshot {
  kind: "clarus"
  agentId: string
  projectId: string
  taskId: string
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ClarusTaskComposerState extends ComposerLifecycleState {
  /** Whether this session is bound to a Clarus task. */
  isClarusTask: boolean
  /** The raw binding snapshot (undefined for non-Clarus sessions). */
  binding: ClarusTaskBindingSnapshot | undefined
  /** The raw endpoint snapshot (undefined for non-Clarus sessions). */
  endpoint: ClarusTaskEndpointSnapshot | undefined
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function tryClarusTaskEndpoint(ep: SessionEndpoint | undefined | null): ClarusTaskEndpointSnapshot | undefined {
  if (ep != null && ep.kind === "clarus" && typeof ep.agentId === "string" && typeof ep.projectId === "string") {
    return {
      kind: "clarus",
      agentId: ep.agentId,
      projectId: ep.projectId,
      taskId: ep.taskId ?? "",
    }
  }
  return undefined
}

const VALID_TASK_STATUSES: ReadonlySet<ClarusTaskStatus> = new Set([
  "waiting",
  "running",
  "needs_attention",
  "submitting",
  "submitted",
  "expired",
  "cancelled",
  "failed",
])

const VALID_RESULT_STATES: ReadonlySet<ClarusTaskResultState> = new Set([
  "idle",
  "prepared",
  "dispatched",
  "acknowledged",
  "ambiguous",
  "rejected",
  "local_only",
])

function toStatus(val: unknown): ClarusTaskStatus {
  if (typeof val !== "string") return "waiting"
  if (VALID_TASK_STATUSES.has(val as ClarusTaskStatus)) return val as ClarusTaskStatus
  return "waiting"
}

function toResultState(val: unknown): ClarusTaskResultState {
  if (typeof val !== "string") return "idle"
  if (VALID_RESULT_STATES.has(val as ClarusTaskResultState)) return val as ClarusTaskResultState
  return "idle"
}

const NON_CLARUS_STATE: ClarusTaskComposerState = {
  isClarusTask: false,
  binding: undefined,
  endpoint: undefined,
  isInputEnabled: true,
  isReadOnly: false,
  canSubmitResult: false,
  canContinueLocally: false,
  isContinueLocallyPermanent: false,
  inputPlaceholder: "",
  headerStatusLabel: "",
}

/**
 * Derive the full Clarus composer state from the session endpoint and the
 * resolved task binding snapshot.
 *
 * Non-Clarus sessions return `isClarusTask: false` with neutral defaults.
 * Clarus task sessions delegate to the pure lifecycle model.
 */
export function deriveClarusTaskComposerState(
  rawEndpoint: SessionEndpoint | undefined | null,
  binding: ClarusTaskBindingSnapshot | undefined,
): ClarusTaskComposerState {
  if (!binding) return NON_CLARUS_STATE

  const endpoint = tryClarusTaskEndpoint(rawEndpoint)
  if (!endpoint) return NON_CLARUS_STATE

  const lifecycle = composeTaskLifecycle({
    taskStatus: toStatus(binding.status),
    resultState: toResultState(binding.resultState),
    localContinuationEnabled: typeof binding.localContinuationEnabledAt === "number",
  })

  return {
    isClarusTask: true,
    binding,
    endpoint,
    ...lifecycle,
  }
}

// Re-export types used by tests and consumers
export type { ClarusTaskStatus, ClarusTaskResultState }
