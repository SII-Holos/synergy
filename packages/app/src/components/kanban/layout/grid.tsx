import { For } from "solid-js"
import type { JSX } from "solid-js"
import type { BoardPane } from "../model/pane-selection"

export function KanbanGrid(props: { panes: BoardPane[]; renderPane: (pane: BoardPane) => JSX.Element }) {
  return (
    <div data-component="kanban-layout-grid" class="kanban-grid">
      <For each={props.panes}>{(pane) => <div class="kanban-grid-cell">{props.renderPane(pane)}</div>}</For>
    </div>
  )
}
