import type { SessionTransitionPhase } from "./session-transition-progress"

export const SESSION_TRANSITION_SUCCESS_HOLD_MS = 3_000
export const SESSION_TRANSITION_EXIT_MS = 180

export type SessionTransitionTimerDriver<Handle = ReturnType<typeof setTimeout>> = {
  setTimeout: (callback: () => void, delay: number) => Handle
  clearTimeout: (handle: Handle) => void
}

export function createSessionTransitionLifecycle<Handle>(input: {
  phase: SessionTransitionPhase
  onExit: () => void
  onDismiss: () => void
  timers: SessionTransitionTimerDriver<Handle>
}) {
  let holdTimer: Handle | undefined
  let exitTimer: Handle | undefined
  let exiting = false
  let dismissed = false
  let disposed = false

  const clearHoldTimer = () => {
    if (holdTimer === undefined) return
    input.timers.clearTimeout(holdTimer)
    holdTimer = undefined
  }
  const clearExitTimer = () => {
    if (exitTimer === undefined) return
    input.timers.clearTimeout(exitTimer)
    exitTimer = undefined
  }
  const dismiss = () => {
    if (disposed || dismissed) return
    dismissed = true
    input.onDismiss()
  }
  const beginExit = () => {
    if (disposed || exiting || dismissed) return
    exiting = true
    clearHoldTimer()
    input.onExit()
    exitTimer = input.timers.setTimeout(() => {
      exitTimer = undefined
      dismiss()
    }, SESSION_TRANSITION_EXIT_MS)
  }

  if (input.phase === "success") {
    holdTimer = input.timers.setTimeout(beginExit, SESSION_TRANSITION_SUCCESS_HOLD_MS)
  }

  return {
    beginExit,
    cleanup() {
      clearHoldTimer()
      clearExitTimer()
      if (input.phase === "success") dismiss()
      disposed = true
    },
  }
}
