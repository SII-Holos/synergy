import { For, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"

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
  // Key rows by the stable pane key so status/navigation updates never destroy
  // and recreate the whole message tree (mirrors the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))
  return (
    <div data-component="kanban-layout-waterfall" class="kanban-waterfall">
      <For each={snapshot().keys}>
        {(key) => {
          const pane = () => snapshot().map.get(key)
          const current = pane()
          if (!current) return null
          return <div class="kanban-waterfall-col">{props.renderPane(current, "waterfall")}</div>
        }}
      </For>
    </div>
  )
}
