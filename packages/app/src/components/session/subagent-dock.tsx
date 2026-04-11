import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import type { CortexTask } from "@ericsanchezok/synergy-sdk/client"
import "./subagent-dock.css"

const AGENT_CONFIG: Record<string, { emoji: string; label: string; color: string }> = {
  master: { emoji: "\u{1F528}", label: "Master", color: "rgba(59, 130, 246, 0.35)" },
  explore: { emoji: "\u{1F50D}", label: "Explorer", color: "rgba(168, 85, 247, 0.35)" },
  scribe: { emoji: "\u270F\uFE0F", label: "Scribe", color: "rgba(34, 197, 94, 0.35)" },
  scholar: { emoji: "\u{1F4DA}", label: "Scholar", color: "rgba(245, 158, 11, 0.35)" },
  scout: { emoji: "\u{1F9ED}", label: "Scout", color: "rgba(6, 182, 212, 0.35)" },
  advisor: { emoji: "\u{1F9D0}", label: "Advisor", color: "rgba(236, 72, 153, 0.35)" },
}

const DEFAULT_AGENT_CONFIG = { emoji: "\u{1F916}", label: "Agent", color: "rgba(107, 114, 128, 0.35)" }
const HOLD_TO_CANCEL_MS = 700
const HOLD_RING_CIRCUMFERENCE = 2 * Math.PI * 19

function getAgentConfig(agent: string) {
  return AGENT_CONFIG[agent] ?? DEFAULT_AGENT_CONFIG
}

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
  const params = useParams()
  const navigate = useNavigate()
  const config = createMemo(() => getAgentConfig(props.task.agent))
  const isQueued = () => props.task.status === "queued"
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
    return (
      <div class="subagent-popover flex flex-col gap-1.5 py-1 max-w-56">
        <div class="flex items-center gap-2">
          <span class="text-13-medium">
            {cfg.emoji} {cfg.label}
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
        <span class="text-11-regular text-text-interactive-base">
          {isQueued() ? "Queued — waiting for slot" : "Tap to open · press and hold to cancel"}
        </span>
      </div>
    )
  }

  return (
    <div class="subagent-dock-item" style={{ "animation-delay": `${props.index * 60}ms` }}>
      <Tooltip value={tooltipContent()} placement="top">
        <button
          type="button"
          aria-label={
            isQueued() ? `${config().label} queued` : `Open ${props.task.description}. Press and hold to cancel.`
          }
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          class={`subagent-avatar subagent-avatar-${props.task.agent} group relative flex items-center justify-center size-9 rounded-full border border-border-base bg-surface-raised-stronger-non-alpha transition-all duration-200 ${isQueued() ? "subagent-avatar-queued opacity-50 cursor-default" : "cursor-pointer hover:scale-110 hover:border-border-strong hover:shadow-md active:scale-95"} ${isHolding() ? "subagent-avatar-holding" : ""}`}
          style={{ "--subagent-glow-color": config().color }}
        >
          <Show when={!isQueued() && isHolding()}>
            <svg class="subagent-hold-ring absolute inset-0 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
              <circle class="subagent-hold-ring-track" cx="22" cy="22" r="19" />
              <circle
                class="subagent-hold-ring-progress"
                cx="22"
                cy="22"
                r="19"
                style={{
                  "stroke-dasharray": `${HOLD_RING_CIRCUMFERENCE}`,
                  "stroke-dashoffset": `${ringOffset()}`,
                }}
              />
            </svg>
          </Show>
          <span class="subagent-icon text-base leading-none select-none">{config().emoji}</span>
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
      <div class="flex items-center justify-center gap-2 pb-2">
        <For each={activeTasks()}>
          {(task, index) => <SubagentAvatar task={task} index={index()} onCancel={handleCancel} />}
        </For>
      </div>
    </Show>
  )
}
