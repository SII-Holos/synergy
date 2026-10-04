import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { CortexTask } from "@ericsanchezok/synergy-sdk/client"
import { useSessionDataView } from "@/context/session-data-view"
import { useSDK } from "@/context/sdk"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import { getAgentVisual } from "@/components/agent-visual"
import { resolveRuntimeIconState } from "@/components/status-bar/runtime"
import { translateDescriptor } from "@/locales/translate"
import { requestErrorMessage } from "@/utils/error"
import { S } from "./session-i18n"
import { sharedSecondTick } from "./second-tick"
import { useSessionSurfaceFocus } from "./session-surface-focus"
import "./subagent-dock.css"

const HOLD_MS = 2000
const RING_LENGTH = 2 * Math.PI * 19

function SubagentAvatar(props: { task: CortexTask; suppressed?: boolean }) {
  const view = useSessionDataView()
  const sdk = useSDK()
  const openSession = useNavigateToSession()
  const returnFocus = useSessionSurfaceFocus()
  const { i18n } = useLingui()
  const visual = createMemo(() => getAgentVisual(props.task.agent))
  const status = () => view().statusFor(props.task.sessionID)
  const runtime = () => resolveRuntimeIconState(status(), false, i18n())
  const queued = () => props.task.status === "queued"
  const [progress, setProgress] = createSignal(0)
  const [holding, setHolding] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  let live = true
  let button: HTMLButtonElement | undefined
  let frame = 0
  let pointer: { id: number; x: number; y: number; valid: boolean; completed: boolean } | undefined
  let spaceHeld = false
  let spaceCompleted = false
  let pointerClickAllowed = false
  const clock = sharedSecondTick()
  createEffect(() => {
    if (props.task.status !== "running" && !queued()) return
    onCleanup(clock.subscribe())
  })
  const elapsed = createMemo(() => {
    clock.read()
    const seconds = Math.max(0, Math.floor((Date.now() - props.task.startedAt) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  })
  const stopHold = () => {
    cancelAnimationFrame(frame)
    frame = 0
    setHolding(false)
    setProgress(0)
  }
  const abort = () => {
    pointer = undefined
    pointerClickAllowed = false
    spaceHeld = false
    stopHold()
  }
  const cancel = async () => {
    if (props.suppressed || pending() || queued() || props.task.status !== "running") return
    setPending(true)
    try {
      await sdk.client.cortex.cancel({ taskID: props.task.id }, { throwOnError: true })
    } catch (error) {
      if (!live) return
      setPending(false)
      showToast({
        type: "error",
        title: i18n()._(S.subagentCancelFailed),
        description: requestErrorMessage(error, i18n()._(S.subagentCancelFailed)),
      })
    }
  }
  const beginHold = (complete: () => void) => {
    const started = performance.now()
    setHolding(true)
    const tick = (now: number) => {
      const next = Math.min(1, (now - started) / HOLD_MS)
      setProgress(next)
      if (next < 1) {
        frame = requestAnimationFrame(tick)
        return
      }
      complete()
      stopHold()
      void cancel()
    }
    frame = requestAnimationFrame(tick)
  }
  const open = () => {
    if (!props.suppressed && !queued() && !pending() && props.task.status === "running")
      openSession(props.task.sessionID)
  }
  createEffect(() => {
    if (props.suppressed || props.task.status !== "running") abort()
  })
  window.addEventListener("blur", abort)
  const visibility = () => {
    if (document.hidden) abort()
  }
  document.addEventListener("visibilitychange", visibility)
  onCleanup(() => {
    const focused = button === document.activeElement
    live = false
    abort()
    window.removeEventListener("blur", abort)
    document.removeEventListener("visibilitychange", visibility)
    if (focused)
      queueMicrotask(() => {
        if (document.activeElement === document.body) returnFocus()
      })
  })
  const ariaLabel = () =>
    i18n()._({
      ...(queued() ? S.subagentAriaQueued : S.subagentAriaLabel),
      values: { agent: translateDescriptor(visual().label, i18n()), description: props.task.description },
    })
  return (
    <Tooltip
      placement="top"
      inactive={props.suppressed}
      value={
        <div class="subagent-popover">
          <div class="subagent-popover-heading">
            <span>
              {visual().emoji} {translateDescriptor(visual().label, i18n())}
            </span>
            <span>{elapsed()}</span>
          </div>
          <div>{props.task.description}</div>
          <Show when={props.task.progress}>
            {(progress) => (
              <div class="subagent-popover-detail">
                {i18n()._({ ...S.subagentToolsCount, values: { count: progress().toolCalls } })}
                <Show when={progress().lastTool}> · {progress().lastTool}</Show>
              </div>
            )}
          </Show>
          <Show when={status()?.type === "retry"}>
            <div class="subagent-popover-retry">
              <Icon name={runtime().icon} size="small" />
              <span>{runtime().tooltip}</span>
            </div>
          </Show>
          <span class="subagent-popover-hint">{i18n()._(queued() ? S.subagentQueuedWait : S.subagentTapToOpen)}</span>
        </div>
      }
    >
      <button
        ref={button}
        type="button"
        class="subagent-dock-avatar"
        aria-label={ariaLabel()}
        aria-busy={pending()}
        aria-disabled={queued() || pending()}
        data-queued={queued()}
        data-holding={holding()}
        data-retrying={status()?.type === "retry"}
        style={{ "--subagent-accent-color": visual().color }}
        onPointerDown={(event) => {
          if (
            props.suppressed ||
            queued() ||
            pending() ||
            event.button !== 0 ||
            !event.isPrimary ||
            pointer ||
            spaceHeld
          )
            return
          pointerClickAllowed = false
          pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, valid: true, completed: false }
          event.currentTarget.setPointerCapture(event.pointerId)
          beginHold(() => {
            if (pointer) pointer.completed = true
          })
        }}
        onPointerMove={(event) => {
          if (!pointer || event.pointerId !== pointer.id) return
          const box = event.currentTarget.getBoundingClientRect()
          if (
            Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8 ||
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            abort()
        }}
        onPointerLeave={(event) => {
          if (!pointer || event.pointerId === pointer.id) abort()
        }}
        onPointerCancel={(event) => {
          if (pointer && event.pointerId !== pointer.id) return
          abort()
          pointer = undefined
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onLostPointerCapture={(event) => {
          if (pointer && event.pointerId !== pointer.id) return
          if (pointer) {
            abort()
            pointer = undefined
          }
        }}
        onPointerUp={(event) => {
          if (!pointer || event.pointerId !== pointer.id) return
          pointerClickAllowed = pointer.valid && !pointer.completed
          pointer = undefined
          stopHold()
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onClick={(event) => {
          if (!holding() && (event.detail === 0 || pointerClickAllowed)) open()
          pointerClickAllowed = false
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            abort()
            return
          }
          if (event.key !== " " || event.repeat || props.suppressed || queued() || pending() || pointer || spaceHeld)
            return
          event.preventDefault()
          spaceHeld = true
          spaceCompleted = false
          beginHold(() => {
            spaceCompleted = true
          })
        }}
        onKeyUp={(event) => {
          if (event.key !== " ") return
          event.preventDefault()
          const activate = spaceHeld && !spaceCompleted
          spaceHeld = false
          stopHold()
          if (activate) open()
        }}
        onBlur={abort}
        onContextMenu={(event) => event.preventDefault()}
      >
        <Show when={holding()}>
          <svg class="subagent-hold-ring" viewBox="0 0 44 44" aria-hidden="true">
            <circle class="subagent-hold-ring-track" cx="22" cy="22" r="19" fill="none" />
            <circle
              class="subagent-hold-ring-progress"
              cx="22"
              cy="22"
              r="19"
              fill="none"
              style={{ "stroke-dasharray": RING_LENGTH, "stroke-dashoffset": RING_LENGTH * (1 - progress()) }}
            />
          </svg>
        </Show>
        <span aria-hidden="true" class="subagent-dock-emoji">
          {visual().emoji}
        </span>
      </button>
    </Tooltip>
  )
}

export function SubagentDock(props: { sessionID: string; suppressed?: boolean }) {
  const view = useSessionDataView()
  const tasks = createMemo(() =>
    view()
      .cortexTasks()
      .filter(
        (task) => task.parentSessionID === props.sessionID && (task.status === "running" || task.status === "queued"),
      )
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
  )
  const { i18n } = useLingui()
  return (
    <Show when={tasks().length}>
      <div class="subagent-dock" role="group" aria-label={i18n()._(S.subagentDockLabel)}>
        <For each={tasks()}>{(task) => <SubagentAvatar task={task} suppressed={props.suppressed} />}</For>
      </div>
    </Show>
  )
}
