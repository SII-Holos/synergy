import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"

export interface TurnExecutionSummary {
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown"
  elapsedMs: number | null
}
const copy = {
  running: { id: "ui.execution.running", message: "Running" },
  completed: { id: "ui.execution.completed", message: "Completed" },
  failed: { id: "ui.execution.failed", message: "Failed" },
  cancelled: { id: "ui.execution.cancelled", message: "Cancelled" },
  interrupted: { id: "ui.execution.interrupted", message: "Interrupted" },
  unknown: { id: "ui.execution.unknown", message: "Status not recorded" },
  details: { id: "ui.execution.details", message: "Details" },
} as const

export function ExecutionCompletion(props: { summary?: TurnExecutionSummary; onDetails?: () => void }) {
  const { _ } = useLingui()
  const status = () => {
    switch (props.summary?.status) {
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
  const duration = () => {
    const seconds = Math.max(0, Math.floor((props.summary?.elapsedMs ?? 0) / 1000))
    return (
      Math.floor(seconds / 60)
        .toString()
        .padStart(2, "0") +
      ":" +
      (seconds % 60).toString().padStart(2, "0")
    )
  }
  return (
    <div data-component="execution-completion" data-state={props.summary?.status}>
      <Show when={props.summary}>
        <span>{status()}</span>
        <Show when={props.summary?.status !== "unknown" && props.summary?.elapsedMs != null}>
          <span>{duration()}</span>
        </Show>
      </Show>
      <Show when={props.onDetails}>
        <button type="button" onClick={props.onDetails}>
          {_(copy.details)}
        </button>
      </Show>
    </div>
  )
}
