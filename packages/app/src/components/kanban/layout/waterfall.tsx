import { For } from "solid-js"
import type { JSX } from "solid-js"
import type { BoardPane } from "../model/pane-selection"

/**
 * Waterfall layout: exactly three columns, one session per column, columns
 * ordered by last activity (pinned first). Each column renders the session's
 * messages in chronological order with per-message timestamps, so the three
 * streams are time-aligned for at-a-glance pace comparison. Below 768 px it
 * degrades to a single column.
 */
export function KanbanWaterfall(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane, variant?: "waterfall") => JSX.Element
}) {
  return (
    <div data-component="kanban-layout-waterfall" class="kanban-waterfall">
      <For each={props.panes}>
        {(pane) => <div class="kanban-waterfall-col">{props.renderPane(pane, "waterfall")}</div>}
      </For>
    </div>
  )
}
