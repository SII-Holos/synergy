import { For, Show, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"
import { FlipPanes } from "../flip"

export function KanbanGrid(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane) => JSX.Element
  /** Fixed grid columns (1–4). */
  cols: number
  /** Fixed grid rows (1–3); extra panes overflow. */
  rows: number
  /** Reorder pinned panes by swapping the dragged key onto a target key. */
  onReorder: (fromKey: string, toKey: string) => void
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
    <FlipPanes entries={props.panes} class="kanban-grid" style={gridStyle()}>
      <For each={snapshot().keys}>
        {(key) => (
          <div class="kanban-grid-cell" data-pane-key={key}>
            <Show when={snapshot().map.get(key)}>{(current) => props.renderPane(current())}</Show>
          </div>
        )}
      </For>
    </FlipPanes>
  )
}
