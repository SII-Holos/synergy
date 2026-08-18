import { For, createMemo } from "solid-js"
import type { JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"
import { spanFor, type PaneSpan } from "../model/preferences"

export function KanbanGrid(props: {
  panes: BoardPane[]
  renderPane: (pane: BoardPane) => JSX.Element
  /** Fixed grid columns (1–4). Ignored in free layout mode. */
  cols: number
  /** Fixed grid rows (1–4); extra panes overflow. Ignored in free layout mode. */
  rows: number
  /** Free layout: panes may span cells; CSS grid auto-places them. */
  freeLayout: boolean
  paneSpans: Record<string, PaneSpan>
  onSpanChange?: (key: string, span: PaneSpan) => void
}) {
  // Key rows by the stable pane key so status/navigation updates that recompute
  // `panes()` never destroy and recreate the whole message tree (mirrors
  // `buildConversationTimelineSnapshot` in the session conversation).
  const snapshot = createMemo(() => buildPaneSnapshot(props.panes))

  const gridStyle = () =>
    props.freeLayout
      ? {
          display: "grid",
          "grid-template-columns": "repeat(4, minmax(0, 1fr))",
          "grid-auto-flow": "row dense",
          "grid-auto-rows": "minmax(260px, auto)",
        }
      : {
          display: "grid",
          "grid-template-columns": `repeat(${props.cols}, minmax(0, 1fr))`,
          "grid-auto-rows": "minmax(260px, auto)",
        }

  return (
    <div data-component="kanban-layout-grid" class="kanban-grid" style={gridStyle()}>
      <For each={snapshot().keys}>
        {(key) => {
          const pane = () => snapshot().map.get(key)
          const current = pane()
          if (!current) return null
          const span = spanFor(props.paneSpans, key)
          const spanStyle =
            props.freeLayout && (span.cols > 1 || span.rows > 1)
              ? { "grid-column": `span ${span.cols}`, "grid-row": `span ${span.rows}` }
              : undefined
          return (
            <div class="kanban-grid-cell" style={spanStyle}>
              {props.renderPane(current)}
            </div>
          )
        }}
      </For>
    </div>
  )
}
