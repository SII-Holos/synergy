/**
 * Pure Clarus composer lifecycle model.
 *
 * Maps a task status, resultState, and localContinuationEnabled flag
 * onto a deterministic ComposerLifecycleState with no side effects.
 */
export type ClarusTaskStatus =
  | "waiting"
  | "running"
  | "needs_attention"
  | "submitting"
  | "submitted"
  | "expired"
  | "cancelled"
  | "failed"

export type ClarusTaskResultState =
  | "idle"
  | "prepared"
  | "dispatched"
  | "acknowledged"
  | "ambiguous"
  | "rejected"
  | "local_only"

export interface ComposerLifecycleInput {
  taskStatus: ClarusTaskStatus
  resultState: ClarusTaskResultState
  localContinuationEnabled: boolean
}

export interface ComposerLifecycleState {
  isInputEnabled: boolean
  isReadOnly: boolean
  canSubmitResult: boolean
  canContinueLocally: boolean
  isContinueLocallyPermanent: boolean
  inputPlaceholder: string
  headerStatusLabel: string
  headerResultLabel?: string
}

const PRE_RESULT_ACTIVE: ReadonlySet<ClarusTaskStatus> = new Set(["waiting", "running", "needs_attention"])
const TERMINAL_STATUSES: ReadonlySet<ClarusTaskStatus> = new Set(["expired", "cancelled", "failed"])

const LOCAL_GUIDANCE_PLACEHOLDER = "Local guidance for this Clarus task"

function statusLabel(status: ClarusTaskStatus): string {
  switch (status) {
    case "waiting":
      return "Waiting for assignment"
    case "running":
      return "Running"
    case "needs_attention":
      return "Needs attention"
    case "submitting":
      return "Submitting result to Clarus…"
    case "submitted":
      return "Submitted to Clarus"
    case "expired":
      return "Task expired"
    case "cancelled":
      return "Task cancelled"
    case "failed":
      return "Task failed"
  }
}

function resultLabel(resultState: ClarusTaskResultState): string | undefined {
  switch (resultState) {
    case "acknowledged":
      return "Result acknowledged"
    case "rejected":
      return "Result rejected"
    case "ambiguous":
      return "Submission status unknown"
    case "local_only":
      return "Result not eligible"
    case "idle":
      return undefined
    case "prepared":
    case "dispatched":
      return undefined
  }
}

export function composeTaskLifecycle(input: ComposerLifecycleInput): ComposerLifecycleState {
  const { taskStatus, resultState, localContinuationEnabled } = input

  // ---- Terminal statuses: read-only, no input, no actions ----
  if (TERMINAL_STATUSES.has(taskStatus)) {
    return {
      isInputEnabled: false,
      isReadOnly: true,
      canSubmitResult: false,
      canContinueLocally: false,
      isContinueLocallyPermanent: false,
      inputPlaceholder: statusLabel(taskStatus),
      headerStatusLabel: statusLabel(taskStatus),
    }
  }

  // ---- Ambiguous resultState: terminal read-only, no retry, no Continue ----
  if (resultState === "ambiguous") {
    const label = "Submission status unknown; no automatic retry"
    return {
      isInputEnabled: false,
      isReadOnly: true,
      canSubmitResult: false,
      canContinueLocally: false,
      isContinueLocallyPermanent: false,
      inputPlaceholder: label,
      headerStatusLabel: label,
    }
  }

  // ---- Rejected resultState: terminal read-only, no retry, no Continue ----
  if (resultState === "rejected") {
    return {
      isInputEnabled: false,
      isReadOnly: true,
      canSubmitResult: false,
      canContinueLocally: false,
      isContinueLocallyPermanent: false,
      inputPlaceholder: "Result rejected; no automatic retry",
      headerStatusLabel: statusLabel(taskStatus),
      headerResultLabel: "Result rejected",
    }
  }

  // ---- Submitted: read-only unless local continuation enabled ----
  if (taskStatus === "submitted") {
    if (localContinuationEnabled) {
      return {
        isInputEnabled: true,
        isReadOnly: false,
        canSubmitResult: false,
        canContinueLocally: true,
        isContinueLocallyPermanent: true,
        inputPlaceholder: "Continue working locally…",
        headerStatusLabel: "Local continuation",
        headerResultLabel: "Result not eligible",
      }
    }

    const ackLabel = resultState === "acknowledged" ? "Result acknowledged" : "Result submitted"
    return {
      isInputEnabled: false,
      isReadOnly: true,
      canSubmitResult: false,
      canContinueLocally: true,
      isContinueLocallyPermanent: false,
      inputPlaceholder: "Submitted to Clarus",
      headerStatusLabel: "Submitted to Clarus",
      headerResultLabel: ackLabel,
    }
  }

  // ---- Submitting / dispatched: disabled, draft preserved ----
  if (taskStatus === "submitting" || resultState === "prepared" || resultState === "dispatched") {
    const label = "Submitting result to Clarus…"
    return {
      isInputEnabled: false,
      isReadOnly: false,
      canSubmitResult: false,
      canContinueLocally: false,
      isContinueLocallyPermanent: false,
      inputPlaceholder: label,
      headerStatusLabel: label,
    }
  }

  // ---- local_only: input enabled, result-ineligible permanently ----
  if (resultState === "local_only") {
    return {
      isInputEnabled: true,
      isReadOnly: false,
      canSubmitResult: false,
      canContinueLocally: false,
      isContinueLocallyPermanent: false,
      inputPlaceholder: LOCAL_GUIDANCE_PLACEHOLDER,
      headerStatusLabel: "Local only",
      headerResultLabel: "Result not eligible",
    }
  }

  // ---- Pre-result states (waiting, running, needs_attention with idle): local guidance enabled ----
  return {
    isInputEnabled: true,
    isReadOnly: false,
    canSubmitResult: true,
    canContinueLocally: false,
    isContinueLocallyPermanent: false,
    inputPlaceholder: LOCAL_GUIDANCE_PLACEHOLDER,
    headerStatusLabel: statusLabel(taskStatus),
  }
}
