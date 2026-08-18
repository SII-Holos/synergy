import { For, Show, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { kanbanPage } from "@/locales/messages"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"
import { FlipPanes } from "../flip"

export function KanbanFocus(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane, variant: "focus" | "rail") => JSX.Element
}) {
  const { _ } = useLingui()
  const [activeKey, setActiveKey] = createSignal<string | undefined>(props.panes[0]?.key)

  // Key rows by the stable pane key so status/navigation updates never destroy
  // and recreate the whole message tree (mirrors the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))
  const active = createMemo(() => {
    const key = activeKey()
    return (key ? snapshot().map.get(key) : undefined) ?? props.panes[0]
  })
  const railKeys = createMemo(() => snapshot().keys.filter((key) => key !== active()?.key))

  return (
    <FlipPanes entries={props.panes} class="kanban-focus">
      <Show when={active()}>
        {(current) => (
          <div class="kanban-focus-main" data-pane-key={current().key}>
            {props.renderPane(current(), "focus")}
          </div>
        )}
      </Show>
      <div class="kanban-focus-rail">
        <For each={railKeys()}>
          {(key) => {
            const pane = () => snapshot().map.get(key)
            if (!pane()) return null
            // Promote control is a semantic button-like region, not a <button>:
            // the pane inside already contains interactive buttons, so nesting
            // them in an outer <button> would be invalid HTML.
            return (
              <div
                class="kanban-focus-promote"
                role="button"
                tabindex={0}
                aria-label={_(kanbanPage.layoutFocus)}
                onClick={() => setActiveKey(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    setActiveKey(key)
                  }
                }}
              >
                <div class="kanban-focus-promote-inner" data-pane-key={key}>
                  {props.renderPane(pane()!, "rail")}
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </FlipPanes>
  )
}
