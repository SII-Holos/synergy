import { For, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"

export function KanbanGrid(props: { panes: BoardPane[]; renderPane: (pane: BoardPane) => JSX.Element }) {
  // Key rows by the stable pane key so status/navigation updates that recompute
  // `panes()` never destroy and recreate the whole message tree (mirrors
  // `buildConversationTimelineSnapshot` in the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))
  return (
    <div data-component="kanban-layout-grid" class="kanban-grid">
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
