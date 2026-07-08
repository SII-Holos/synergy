import { Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type { SessionWorkspaceProgress } from "./worktree-session"
import { StepList } from "./worktree-progress-components"
import "./worktree-transition-dialog.css"

function operationIcon(progress: SessionWorkspaceProgress) {
  if (progress.phase === "success") return getSemanticIcon("state.success")
  if (progress.phase === "error") return getSemanticIcon("state.error")
  if (progress.operation === "leave") return getSemanticIcon("workspace.leaveWorktree")
  if (progress.operation === "enter") return getSemanticIcon("workspace.enterWorktree")
  return getSemanticIcon("workspace.worktree")
}

function operationLabel(progress: SessionWorkspaceProgress) {
  if (progress.operation === "leave") return "Main checkout"
  if (progress.operation === "enter") return "Session worktree"
  return "Worktree session"
}

export function WorktreeTransitionCard(props: {
  progress: SessionWorkspaceProgress
  onRetry?: () => void
  onDismiss?: () => void
}) {
  return (
    <div class="wtd-card" data-phase={props.progress.phase} data-operation={props.progress.operation}>
      <div class="wtd-card-header">
        <span class="wtd-card-icon" data-state={props.progress.phase}>
          <Icon name={operationIcon(props.progress)} size="small" />
        </span>
        <div class="wtd-card-heading">
          <span class="wtd-card-kicker">{operationLabel(props.progress)}</span>
          <span class="wtd-card-title">{props.progress.title}</span>
          <span class="wtd-card-description">{props.progress.description}</span>
        </div>
      </div>
      <Show when={props.progress.steps.length > 0}>
        <StepList steps={props.progress.steps} />
      </Show>
      <Show when={props.onRetry || props.onDismiss}>
        <div class="wtd-actions wtd-card-actions">
          <Show when={props.onDismiss}>
            {(dismiss) => (
              <Button type="button" variant="ghost" size="small" onClick={dismiss()}>
                Dismiss
              </Button>
            )}
          </Show>
          <Show when={props.onRetry}>
            {(retry) => (
              <Button type="button" variant="primary" size="small" onClick={retry()}>
                Retry
              </Button>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
