import { Show, createSignal } from "solid-js"
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
  const [exiting, setExiting] = createSignal(false)

  const handleDismiss = () => {
    setExiting(true)
    setTimeout(() => props.onDismiss?.(), 180)
  }

  return (
    <div
      class="wtd-card"
      classList={{ "wtd-card-exit": exiting() }}
      data-phase={props.progress.phase}
      data-operation={props.progress.operation}
    >
      <div class="wtd-card-header">
        <span class="wtd-card-icon" data-state={props.progress.phase}>
          <Icon name={operationIcon(props.progress)} size="small" />
        </span>
        <div class="wtd-card-heading">
          <span class="wtd-card-kicker">{operationLabel(props.progress)}</span>
          <span class="wtd-card-title">{props.progress.title}</span>
          <span class="wtd-card-description">{props.progress.description}</span>
        </div>
        <Show when={props.onDismiss}>
          <Button
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.close")}
            class="wtd-card-dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss worktree status"
            title="Dismiss"
          />
        </Show>
      </div>
      <Show when={props.progress.steps.length > 0}>
        <StepList steps={props.progress.steps} />
      </Show>
      <Show when={props.onRetry}>
        <div class="wtd-actions wtd-card-actions">
          <Show when={props.onRetry}>
            {(retry) => (
              <Button variant="primary" size="small" onClick={retry()}>
                Retry
              </Button>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
