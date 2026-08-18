import { For, Show, createMemo, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { kanbanPage } from "@/locales/messages"
import type { BoardPane } from "../model/pane-selection"

export function KanbanFocus(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane, variant: "focus" | "rail") => JSX.Element
}) {
  const { _ } = useLingui()
  const [activeKey, setActiveKey] = createSignal<string | undefined>(props.panes[0]?.key)

  const active = createMemo(() => {
    const key = activeKey()
    return props.panes.find((pane) => pane.key === key) ?? props.panes[0]
  })
  const rail = createMemo(() => props.panes.filter((pane) => pane.key !== active()?.key).slice(0, 3))

  return (
    <div data-component="kanban-layout-focus" class="kanban-focus">
      <Show when={active()}>
        <div class="kanban-focus-main">{props.renderPane(active()!, "focus")}</div>
      </Show>
      <div class="kanban-focus-rail">
        <For each={rail()}>
          {(pane) => (
            // Promote control is a semantic button-like region, not a <button>:
            // the pane inside already contains interactive buttons, so nesting
            // them in an outer <button> would be invalid HTML.
            <div
              class="kanban-focus-promote"
              role="button"
              tabindex={0}
              aria-label={_(kanbanPage.layoutFocus)}
              onClick={() => setActiveKey(pane.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  setActiveKey(pane.key)
                }
              }}
            >
              {props.renderPane(pane, "rail")}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
