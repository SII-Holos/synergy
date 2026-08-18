import { For, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"

export function KanbanGrid(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane) => JSX.Element
  /** Fixed grid columns (1–4). */
  cols: number
  /** Fixed grid rows (1–4); extra panes overflow. */
  rows: number
}) {
  // Key rows by the stable pane key so status/navigation updates that recompute
  // `panes()` never destroy and recreate the whole message tree (mirrors
  // `buildConversationTimelineSnapshot` in the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))

  const gridStyle = () => ({
    display: "grid",
    "grid-template-columns": `repeat(${props.cols}, minmax(0, 1fr))`,
    "grid-template-rows": `repeat(${props.rows}, minmax(0, 1fr))`,
    "grid-auto-rows": "260px",
  })

  return (
    <div data-component="kanban-layout-grid" class="kanban-grid" style={gridStyle()}>
      <For each={snapshot().keys}>
        {(key) => {
          const pane = () => snapshot().map.get(key)
          const current = pane()
          if (!current) return null
          return <div class="kanban-grid-cell">{props.renderPane(current)}</div>
        }}
      </For>
    </div>
  )
}
