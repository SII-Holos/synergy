import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { sessionTransitionPresentation, type SessionTransitionProgress } from "./session-transition-progress"
import {
  createSessionTransitionLifecycle,
  type SessionTransitionTimerDriver,
} from "./session-transition-card-lifecycle"
import { SessionTransitionStepList } from "./session-transition-progress-steps"
import "./session-transition-card.css"

const browserTimers: SessionTransitionTimerDriver = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
}

export function SessionTransitionCard(props: {
  progress: SessionTransitionProgress
  onRetry?: () => void
  onDismiss?: () => void
}) {
  const [exiting, setExiting] = createSignal(false)
  let lifecycle: ReturnType<typeof createSessionTransitionLifecycle> | undefined

  createEffect(() => {
    const progress = props.progress
    const onDismiss = props.onDismiss
    setExiting(false)

    if (!onDismiss) {
      lifecycle = undefined
      return
    }

    const current = createSessionTransitionLifecycle({
      phase: progress.phase,
      onExit: () => setExiting(true),
      onDismiss,
      timers: browserTimers,
    })
    lifecycle = current
    onCleanup(() => {
      current.cleanup()
      if (lifecycle === current) lifecycle = undefined
    })
  })

  const presentation = () => sessionTransitionPresentation(props.progress)
  const handleDismiss = () => lifecycle?.beginExit()

  return (
    <div
      class="session-transition-card"
      classList={{ "session-transition-card-exit": exiting() }}
      data-kind={props.progress.kind}
      data-phase={props.progress.phase}
      data-exiting={exiting() ? "true" : "false"}
      role={props.progress.phase === "error" ? "alert" : "status"}
      aria-live={props.progress.phase === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <div class="session-transition-card-header">
        <span class="session-transition-card-icon" data-state={props.progress.phase}>
          <Icon name={presentation().icon} size="small" />
        </span>
        <div class="session-transition-card-heading">
          <span class="session-transition-card-kicker">{presentation().kicker}</span>
          <span class="session-transition-card-title">{props.progress.title}</span>
          <span class="session-transition-card-description">{props.progress.description}</span>
        </div>
        <Show when={props.onDismiss}>
          <Button
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.close")}
            class="session-transition-card-dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss session progress"
            title="Dismiss"
          />
        </Show>
      </div>
      <Show when={props.progress.steps.length > 0}>
        <SessionTransitionStepList steps={props.progress.steps} />
      </Show>
      <Show when={props.onRetry}>
        {(retry) => (
          <div class="session-transition-card-actions">
            <Button variant="primary" size="small" onClick={retry()}>
              Retry
            </Button>
          </div>
        )}
      </Show>
    </div>
  )
}
