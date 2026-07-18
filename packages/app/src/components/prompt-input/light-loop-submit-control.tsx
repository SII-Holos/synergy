import { createSignal, onCleanup } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"

const HOLD_DURATION_MS = 2000

export function LightLoopSubmitControl(props: {
  taskDescription: string
  onEdit: () => void
  onCancel: () => Promise<void>
}) {
  const [holdTimer, setHoldTimer] = createSignal<ReturnType<typeof setTimeout> | null>(null)
  const [holdProgress, setHoldProgress] = createSignal(0)
  let holdFrame: number | undefined
  let completedHold = false

  const cancelHold = () => {
    const timer = holdTimer()
    if (timer) {
      clearTimeout(timer)
      setHoldTimer(null)
    }
    if (holdFrame !== undefined) {
      cancelAnimationFrame(holdFrame)
      holdFrame = undefined
    }
    setHoldProgress(0)
  }

  const startHold = (event: PointerEvent) => {
    if (event.button !== 0 || holdTimer()) return
    completedHold = false
    const startedAt = performance.now()
    const tick = (now: number) => {
      setHoldProgress(Math.min(1, (now - startedAt) / HOLD_DURATION_MS))
      holdFrame = requestAnimationFrame(tick)
    }
    setHoldProgress(0)
    holdFrame = requestAnimationFrame(tick)
    setHoldTimer(
      setTimeout(async () => {
        setHoldTimer(null)
        if (holdFrame !== undefined) cancelAnimationFrame(holdFrame)
        holdFrame = undefined
        setHoldProgress(1)
        completedHold = true
        try {
          await props.onCancel()
        } finally {
          setHoldProgress(0)
        }
      }, HOLD_DURATION_MS),
    )
  }

  const handleClick = (event: MouseEvent) => {
    if (completedHold) {
      completedHold = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    props.onEdit()
  }

  onCleanup(cancelHold)

  return (
    <Tooltip
      placement="top"
      value={
        <div class="min-w-56 max-w-72">
          <div class="text-12-medium text-text-strong line-clamp-2">{props.taskDescription}</div>
          <div class="mt-2 text-10-regular text-text-weak">Click to view or edit the task.</div>
          <div class="mt-1 text-10-regular text-text-weak">Hold for 2 seconds to stop and exit Light Loop.</div>
        </div>
      }
    >
      <button
        type="button"
        class="prompt-input-toolbar-icon-button group relative flex size-8 items-center justify-center overflow-hidden select-none"
        aria-label="Light Loop task. Click to edit; hold for 2 seconds to stop and exit."
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onClick={handleClick}
      >
        <span class="relative flex size-4 shrink-0 items-center justify-center">
          <span class="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0">
            <Icon name={getSemanticIcon("prompt.lightLoop")} class="text-icon-interactive-base" size="small" />
          </span>
          <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <Icon name={getSemanticIcon("action.close")} class="text-icon-base" size="small" />
          </span>
        </span>
        <span
          class="absolute bottom-1 left-1 h-0.5 rounded-full bg-text-interactive-base/80 transition-[width] duration-75"
          style={{ width: `${holdProgress() * 75}%` }}
        />
      </button>
    </Tooltip>
  )
}
