import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"

export interface TurnExecutionSummary {
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown" | "queued" | "paused" | "waiting"
  elapsedMs: number | null
  elapsedLowerBound?: boolean
}
const copy = {
  queued: { id: "ui.execution.queued", message: "Queued" },
  paused: { id: "ui.execution.paused", message: "Paused" },
  waiting: { id: "ui.execution.waiting", message: "Waiting for input" },
  running: { id: "ui.execution.running", message: "Running" },
  completed: { id: "ui.execution.completed", message: "Completed" },
  failed: { id: "ui.execution.failed", message: "Failed" },
  cancelled: { id: "ui.execution.cancelled", message: "Cancelled" },
  interrupted: { id: "ui.execution.interrupted", message: "Interrupted" },
  unknown: { id: "ui.execution.unknown", message: "Unknown" },
  details: { id: "ui.execution.details", message: "Details" },
} as const

export function executionDuration(value: number, lowerBound = false) {
  const seconds = Math.max(0, Math.floor(value / 1000))
  return (
    (lowerBound ? "≥ " : "") +
    Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0") +
    ":" +
    (seconds % 60).toString().padStart(2, "0")
  )
}

export function ExecutionCompletion(props: { summary?: TurnExecutionSummary; onDetails?: () => void }) {
  const { _ } = useLingui()
  const status = () => {
    switch (props.summary?.status) {
      case "queued":
        return _(copy.queued)
      case "paused":
        return _(copy.paused)
      case "waiting":
        return _(copy.waiting)
      case "running":
        return _(copy.running)
      case "completed":
        return _(copy.completed)
      case "failed":
        return _(copy.failed)
      case "cancelled":
        return _(copy.cancelled)
      case "interrupted":
        return _(copy.interrupted)
      default:
        return _(copy.unknown)
    }
  }
  return (
    <div data-component="execution-completion" data-state={props.summary?.status}>
      <Show when={props.summary}>
        <span>{status()}</span>
        <Show when={props.summary?.elapsedMs != null}>
          <span>{executionDuration(props.summary!.elapsedMs!, props.summary!.elapsedLowerBound)}</span>
        </Show>
      </Show>
      <Show when={props.onDetails}>
        <button type="button" onClick={() => props.onDetails?.()}>
          {_(copy.details)}
        </button>
      </Show>
    </div>
  )
}
