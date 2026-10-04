import { For, Show, createMemo, createSignal } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { kanbanPage } from "@/locales/messages"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"
import { FlipPanes } from "../flip"
import { FOCUS_RAIL_MAX, FOCUS_RAIL_MIN } from "../model/preferences"

const KEYBOARD_RESIZE_STEP = 16

export function KanbanFocus(props: {
  panes: BoardPane[]
  renderPane: (pane: Accessor<BoardPane>, variant: "focus" | "rail", onActivate?: () => void) => JSX.Element
  /** Persisted rail (right) width in px; the divider updates it live. */
  railWidth: () => number
  /** Persist the new rail width after a drag or keyboard resize. */
  onRailResize: (width: number) => void
}) {
  const { _ } = useLingui()
  const [activeKey, setActiveKey] = createSignal<string | undefined>(props.panes[0]?.key)
  const [dragging, setDragging] = createSignal(false)
  let container: HTMLDivElement | undefined

  const railWidth = () => {
    const width = props.railWidth()
    return Math.min(FOCUS_RAIL_MAX, Math.max(FOCUS_RAIL_MIN, width))
  }

  const startResize = (event: MouseEvent) => {
    event.preventDefault()
    setDragging(true)
    const handleMove = (moveEvent: MouseEvent) => {
      if (!container) return
      const rect = container.getBoundingClientRect()
      const width = rect.right - moveEvent.clientX
      props.onRailResize(Math.min(FOCUS_RAIL_MAX, Math.max(FOCUS_RAIL_MIN, Math.round(width))))
    }
    const handleUp = () => {
      setDragging(false)
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const delta = event.key === "ArrowLeft" ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP
    props.onRailResize(Math.min(FOCUS_RAIL_MAX, Math.max(FOCUS_RAIL_MIN, railWidth() + delta)))
  }

  // Key rows by the stable pane key so status/navigation updates never destroy
  // and recreate the whole message tree (mirrors the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))
  const active = createMemo(() => {
    const key = activeKey()
    return (key ? snapshot().map.get(key) : undefined) ?? props.panes[0]
  })
  const railKeys = createMemo(() => snapshot().keys.filter((key) => key !== active()?.key))
  const activate = (key: string) => {
    setActiveKey(key)
    queueMicrotask(() => container?.querySelector<HTMLButtonElement>(".kanban-focus-main button")?.focus())
  }

  const focusStyle = () => ({
    "--kanban-rail-width": `${railWidth()}px`,
  })

  const bindRoot = (element: HTMLDivElement) => {
    container = element
  }

  return (
    <FlipPanes entries={props.panes} class="kanban-focus" style={focusStyle} rootRef={bindRoot}>
      <Show when={active()}>
        {(current) => (
          <div class="kanban-focus-main" data-pane-key={current().key}>
            {props.renderPane(current, "focus")}
          </div>
        )}
      </Show>
      <div
        class="kanban-focus-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label={_(kanbanPage.focusResizeRail)}
        tabindex={0}
        data-dragging={dragging() || undefined}
        onMouseDown={startResize}
        onKeyDown={handleKeyDown}
      />
      <div class="kanban-focus-rail">
        <For each={railKeys()}>
          {(key) => {
            const pane = () => snapshot().map.get(key)
            return (
              <div class="kanban-focus-promote">
                <div class="kanban-focus-promote-inner" data-pane-key={key}>
                  <Show when={pane()}>{(current) => props.renderPane(current, "rail", () => activate(key))}</Show>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </FlipPanes>
  )
}
