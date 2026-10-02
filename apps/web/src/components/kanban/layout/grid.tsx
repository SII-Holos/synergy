import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { buildPaneSnapshot, type BoardPane } from "../model/pane-selection"
import { FlipPanes } from "../flip"

export function KanbanGrid(props: {
  panes: BoardPane[]
  renderPane: (pane: Accessor<BoardPane>) => JSX.Element
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

  const [width, setWidth] = createSignal<number>()
  let observer: ResizeObserver | undefined
  onCleanup(() => observer?.disconnect())
  function bindRoot(element: HTMLDivElement) {
    observer?.disconnect()
    setWidth(element.getBoundingClientRect().width)
    observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    observer.observe(element)
  }
  const columns = () => {
    const available = width()
    if (available === undefined) return props.cols
    if (available < 640) return 1
    return Math.min(props.cols, Math.max(1, Math.floor((available + 12) / 292)))
  }
  const gridStyle = () => ({
    display: "grid",
    "grid-template-columns": `repeat(${columns()}, minmax(0, 1fr))`,
    "grid-template-rows":
      width() !== undefined && width()! < 640 ? "none" : `repeat(${props.rows}, minmax(320px, 1fr))`,
    "grid-auto-rows": "minmax(320px, 1fr)",
  })

  return (
    <FlipPanes entries={props.panes} class="kanban-grid" rootRef={bindRoot} style={gridStyle()}>
      <For each={snapshot().keys}>
        {(key) => (
          <div class="kanban-grid-cell" data-pane-key={key}>
            <Show when={snapshot().map.get(key)}>{(current) => props.renderPane(current)}</Show>
          </div>
        )}
      </For>
    </FlipPanes>
  )
}
