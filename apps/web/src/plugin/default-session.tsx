import type { PluginComponentProps, PluginSessionLayoutService } from "@ericsanchezok/synergy-plugin"
import { Show, createSignal, onMount, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import { SessionPromptDockAnchor, SessionWorkbenchChrome } from "../components/session/workbench-chrome"

export function DefaultSession(
  props: PluginComponentProps<{ layout: PluginSessionLayoutService }> & { column?: ConversationColumn },
) {
  const layout = props.context.layout
  const [chrome, setChrome] = createSignal<HTMLElement>()
  const [promptAnchor, setPromptAnchor] = createSignal<HTMLElement>()
  return (
    <SessionWorkbenchChrome.Provider value={chrome}>
      <SessionPromptDockAnchor.Provider
        value={{
          element: promptAnchor,
          mount(element, releaseOf) {
            if (!element && releaseOf && promptAnchor() !== releaseOf) return
            setPromptAnchor(element)
          },
        }}
      >
        <div
          class="synergy-workbench-canvas relative bg-background-stronger size-full overflow-hidden flex flex-col"
          data-ui-part="session"
          data-default-session
        >
          <div ref={setChrome} class="session-workbench-controls" />
          <div class="session-workbench-body flex-1 min-h-0 flex flex-col md:flex-row relative">
            <div
              class="session-workbench-pane synergy-workbench-canvas @container relative min-w-0 flex flex-1 flex-col bg-background-stronger pb-0 md:pb-3"
              style={{
                "min-width": layout.minimumWidth() === undefined ? undefined : `${layout.minimumWidth()}px`,
                "--session-content-width": props.column ? `${props.column.width()}px` : undefined,
                "--prompt-height": layout.promptHeight() ? `${layout.promptHeight()}px` : undefined,
              }}
            >
              {layout.render("conversation")}
              {layout.render("composer")}
              <Show when={props.column}>{(column) => <ConversationColumnResize column={column()} />}</Show>
            </div>
            {layout.render("workbench.side")}
          </div>
          {layout.render("workbench.bottom")}
        </div>
      </SessionPromptDockAnchor.Provider>
    </SessionWorkbenchChrome.Provider>
  )
}

type ConversationColumn = { width: () => number; resize: (width: number) => void }

function ConversationColumnResize(props: { column: ConversationColumn }) {
  const { _ } = useLingui()
  const [available, setAvailable] = createSignal(800)
  let root!: HTMLDivElement
  let gesture: { pointer: number; x: number; width: number; stored: number } | undefined
  const width = () => Math.min(available(), props.column.width())
  const minimum = () => Math.min(480, available())
  const resize = (value: number) => props.column.resize(Math.round(Math.max(minimum(), Math.min(available(), value))))
  const cancel = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !gesture) return
    event.preventDefault()
    event.stopPropagation()
    props.column.resize(gesture.stored)
    gesture = undefined
  }
  onMount(() => {
    const pane = root.parentElement!
    const measure = () => setAvailable(pane.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    measure()
    document.addEventListener("keydown", cancel, true)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("keydown", cancel, true)
    })
  })
  return (
    <div ref={root} class="conversation-column-resize">
      <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label={_({ id: "session.column.resize", message: "Resize conversation" })}
        aria-valuemin={minimum()}
        aria-valuemax={available()}
        aria-valuenow={width()}
        class="conversation-column-resize-handle"
        onDblClick={() => props.column.resize(800)}
        onKeyDown={(event) => {
          const next =
            event.key === "ArrowRight"
              ? width() + 32
              : event.key === "ArrowLeft"
                ? width() - 32
                : event.key === "Home"
                  ? 800
                  : event.key === "End"
                    ? available()
                    : undefined
          if (next === undefined) return
          event.preventDefault()
          resize(next)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || gesture) return
          event.preventDefault()
          gesture = { pointer: event.pointerId, x: event.clientX, width: width(), stored: props.column.width() }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!gesture || event.pointerId !== gesture.pointer) return
          resize(gesture.width + 2 * (event.clientX - gesture.x))
        }}
        onPointerUp={() => {
          gesture = undefined
        }}
        onPointerCancel={() => {
          if (gesture) props.column.resize(gesture.stored)
          gesture = undefined
        }}
        onLostPointerCapture={() => {
          gesture = undefined
        }}
      />
    </div>
  )
}
