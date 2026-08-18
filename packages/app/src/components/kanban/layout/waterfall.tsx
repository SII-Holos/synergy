import { For } from "solid-js"
import type { JSX } from "solid-js"
import type { BoardPane } from "../model/pane-selection"

export function KanbanWaterfall(props: { panes: BoardPane[]; renderPane: (pane: BoardPane) => JSX.Element }) {
  return (
    <div data-component="kanban-layout-waterfall" class="kanban-waterfall">
      <For each={props.panes}>{(pane) => <div class="kanban-waterfall-col">{props.renderPane(pane)}</div>}</For>
    </div>
  )
}
