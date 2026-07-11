import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import type { CortexTask, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { getAgentVisual } from "@/components/agent-visual"
import { resolveRuntimeIconState } from "@/components/status-bar"
import "./subagent-dock.css"

type RetrySessionStatus = Extract<SessionStatus, { type: "retry" }>

function isRetryStatus(status: SessionStatus | undefined): status is RetrySessionStatus {
  return status?.type === "retry"
}

const HOLD_TO_CANCEL_MS = 2000
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * 19
function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

interface SubagentAvatarProps {
  task: CortexTask
  index: number
  onCancel: (taskID: string) => void
}

function SubagentAvatar(props: SubagentAvatarProps) {
  const sync = useSync()
  const params = useParams()
  const navigate = useNavigate()
  const config = createMemo(() => getAgentVisual(props.task.agent))
  const isQueued = () => props.task.status === "queued"
  const sessionStatus = createMemo<SessionStatus | undefined>(() => sync.data.session_status[props.task.sessionID])
  const runtimeState = createMemo(() => resolveRuntimeIconState(sessionStatus(), false))
  const isRetrying = () => sessionStatus()?.type === "retry"
  const [elapsed, setElapsed] = createSignal(formatElapsed(props.task.startedAt))
  const [holdProgress, setHoldProgress] = createSignal(0)
  const [isHolding, setIsHolding] = createSignal(false)

  let holdFrame = 0
  let holdStartAt = 0
  let cancelledByHold = false
  let suppressClick = false

  const timer = setInterval(() => setElapsed(formatElapsed(props.task.startedAt)), 1000)

  const stopHold = () => {
    if (holdFrame) cancelAnimationFrame(holdFrame)
    holdFrame = 0
    holdStartAt = 0
    setIsHolding(false)
    setHoldProgress(0)
  }

  onCleanup(() => {
    clearInterval(timer)
    if (holdFrame) cancelAnimationFrame(holdFrame)
  })

  const navigateToSession = () => {
    if (isQueued()) return
    navigate(`/${params.dir}/session/${props.task.sessionID}`)
  }

  const beginHold = () => {
    if (isQueued()) return
    cancelledByHold = false
    holdStartAt = performance.now()
    setIsHolding(true)
    setHoldProgress(0)

    const tick = (now: number) => {
      const progress = Math.min((now - holdStartAt) / HOLD_TO_CANCEL_MS, 1)
      setHoldProgress(progress)
      if (progress >= 1) {
        cancelledByHold = true
        stopHold()
        props.onCancel(props.task.id)
        return
      }
      holdFrame = requestAnimationFrame(tick)
    }

    holdFrame = requestAnimationFrame(tick)
  }

  const handlePointerDown: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent> = (event) => {
    if (isQueued()) return
    if (event.pointerType === "mouse" && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    beginHold()
  }

  const handlePointerUp: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent> = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const didCancel = cancelledByHold
    suppressClick = true
    stopHold()
    if (!didCancel) navigateToSession()
  }

  const handlePointerLeave: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent> = () => {
    if (!isHolding()) return
    stopHold()
  }

  const handlePointerCancel: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent> = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    stopHold()
  }

  const handleClick: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> = (event) => {
    if (suppressClick) {
      suppressClick = false
      event.preventDefault()
      return
    }
    navigateToSession()
  }

  const ringOffset = () => HOLD_RING_CIRCUMFERENCE * (1 - holdProgress())

  const tooltipContent = (): JSX.Element => {
    const task = props.task
    const cfg = config()
    const state = runtimeState()
    const status = sessionStatus()
    const retryStatus = isRetryStatus(status) ? status : undefined
    return (
      <div class="subagent-popover flex flex-col gap-1.5 py-1 max-w-56">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 text-13-medium">
            <span class="select-none leading-none" style={{ "font-size": "14px" }}>
              {cfg.emoji}
            </span>
            <span>{cfg.label}</span>
          </span>

          <span class="text-11-regular text-text-subtle">{elapsed()}</span>
        </div>
        <div class="text-12-regular text-text-weak leading-relaxed line-clamp-2">{task.description}</div>
        <Show when={!isQueued() && task.progress}>
          <div class="flex items-center gap-2 text-11-regular text-text-subtle">
            <Show when={task.progress!.toolCalls > 0}>
              <span>{task.progress!.toolCalls} tools</span>
            </Show>
            <Show when={task.progress!.lastTool}>
              <span class="truncate max-w-28">{task.progress!.lastTool}</span>
            </Show>
          </div>
        </Show>
        <Show when={retryStatus}>
          {(status) => {
            const s = status() as RetrySessionStatus
            return (
              <div class="flex flex-col gap-0.5">
                <div class="flex items-center gap-1.5 text-11-medium text-text-critical-base">
                  <Icon name={state.icon} size="small" />
                  <span>Retry #{s.attempt}</span>
                </div>
                <Show when={s.message}>
                  <span class="text-11-regular text-text-critical-base leading-relaxed break-words line-clamp-3">
                    {s.message}
                  </span>
                </Show>
              </div>
            )
          }}
        </Show>
        <span class="text-11-regular text-text-interactive-base">
          {isQueued() ? "Queued — waiting for slot" : "Tap to open · press and hold to cancel"}
        </span>
      </div>
    )
  }

  const ariaLabel = createMemo(() => {
    if (isQueued()) return `${config().label} queued`
    const status = sessionStatus()
    if (isRetryStatus(status)) {
      return `${config().label}: Retry #${status.attempt} — ${status.message}`
    }
    return `Open ${props.task.description}. Press and hold to cancel.`
  })

  return (
    <div class="subagent-dock-item" style={{ "animation-delay": `${props.index * 60}ms` }}>
      <Tooltip value={tooltipContent()} placement="top">
        <button
          type="button"
          aria-label={ariaLabel()}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          classList={{
            "workbench-control-surface subagent-avatar group relative flex items-center justify-center size-9 rounded-full border transition-all duration-200": true,
            [`subagent-avatar-${props.task.agent}`]: true,
            "subagent-avatar-queued opacity-50 cursor-default": isQueued(),
            "cursor-pointer hover:scale-105 hover:border-border-strong active:scale-95": !isQueued(),
            "subagent-avatar-holding": isHolding(),
            "subagent-avatar-retrying": isRetrying(),
            "border-border-base": !isRetrying(),
            "subagent-avatar-retry-border": isRetrying(),
          }}
          style={{ "--subagent-accent-color": config().color }}
        >
          <Show when={!isQueued() && isHolding()}>
            <svg class="subagent-hold-ring absolute inset-0 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
              <circle class="subagent-hold-ring-track" cx="22" cy="22" r="19" fill="none" />
              <circle
                class="subagent-hold-ring-progress"
                cx="22"
                cy="22"
                r="19"
                fill="none"
                style={{
                  "stroke-dasharray": `${HOLD_RING_CIRCUMFERENCE}`,
                  "stroke-dashoffset": `${ringOffset()}`,
                }}
              />
            </svg>
          </Show>
          <span
            classList={{
              "subagent-icon inline-flex items-center justify-center size-5 select-none text-[16px] leading-none": true,
              "text-icon-base": !isRetrying(),
              "text-icon-critical-base": isRetrying(),
            }}
          >
            {config().emoji}
          </span>
        </button>
      </Tooltip>
    </div>
  )
}

interface SubagentDockProps {
  sessionID: string
}

export function SubagentDock(props: SubagentDockProps) {
  const sync = useSync()
  const sdk = useSDK()

  const activeTasks = createMemo(() =>
    sync.data.cortex
      .filter((t) => t.parentSessionID === props.sessionID && (t.status === "running" || t.status === "queued"))
      .sort((a, b) => a.startedAt - b.startedAt),
  )

  const handleCancel = (taskID: string) => {
    sdk.client.cortex.cancel({ taskID }).catch(() => {})
  }

  return (
    <Show when={activeTasks().length > 0}>
      <div class="flex items-center justify-center gap-2 pb-2 pointer-events-auto">
        <For each={activeTasks()}>
          {(task, index) => <SubagentAvatar task={task} index={index()} onCancel={handleCancel} />}
        </For>
      </div>
    </Show>
  )
}
