import { For, Show, createMemo, createSignal, onMount, onCleanup } from "solid-js"
import "./dag-graph.css"

export interface DagNode {
  id: string
  content: string
  status: string
  deps: string[]
  assign?: string
}

interface LayoutNode {
  node: DagNode
  layer: number
  index: number
  x: number
  y: number
  h: number
}

interface LayoutEdge {
  from: LayoutNode
  to: LayoutNode
}

const MAX_CARD_W = 172
const MIN_CARD_W = 100
const GAP_X = 16
const GAP_Y = 28
const PAD = 8

const HEADER_H = 18
const LINE_H = 17
const CARD_PAD_Y = 14
const CARD_GAP = 3
const CHAR_W = 7.2

function estimateCardH(content: string, cardW: number): number {
  const textW = Math.max(1, cardW - 20)
  const charsPerLine = Math.max(1, Math.floor(textW / CHAR_W))
  const numLines = Math.max(1, Math.ceil(content.length / charsPerLine))
  return CARD_PAD_Y + HEADER_H + CARD_GAP + numLines * LINE_H
}

function computeLayout(nodes: DagNode[], containerWidth: number) {
  if (nodes.length === 0) return { laid: [] as LayoutNode[], edges: [] as LayoutEdge[], width: 0, height: 0, cardW: 0 }

  const map = new Map(nodes.map((n) => [n.id, n]))

  const layers = new Map<string, number>()
  function depth(id: string): number {
    if (layers.has(id)) return layers.get(id)!
    const node = map.get(id)
    const deps = node?.deps
    if (!node || !deps || deps.length === 0) {
      layers.set(id, 0)
      return 0
    }
    const max = Math.max(...deps.map((d) => depth(d)))
    const val = max + 1
    layers.set(id, val)
    return val
  }
  for (const n of nodes) depth(n.id)

  const layerGroups = new Map<number, DagNode[]>()
  for (const n of nodes) {
    const l = layers.get(n.id) ?? 0
    const group = layerGroups.get(l) ?? []
    group.push(n)
    layerGroups.set(l, group)
  }

  const maxLayer = Math.max(...layerGroups.keys(), 0)
  const maxGroupSize = Math.max(...[...layerGroups.values()].map((g) => g.length))

  const cw = containerWidth || 600
  const available = cw - 2 * PAD - (maxGroupSize - 1) * GAP_X
  const cardW = Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, Math.floor(available / maxGroupSize)))

  // compute per-layer max card height
  const layerHeights: number[] = []
  for (let l = 0; l <= maxLayer; l++) {
    const group = layerGroups.get(l) ?? []
    const maxH = Math.max(...group.map((n) => estimateCardH(n.content, cardW)))
    layerHeights.push(maxH)
  }

  const laid: LayoutNode[] = []
  const byId = new Map<string, LayoutNode>()

  let cy = PAD
  for (let l = 0; l <= maxLayer; l++) {
    const group = layerGroups.get(l) ?? []
    const rowWidth = group.length * cardW + (group.length - 1) * GAP_X
    const offsetX = (cw - rowWidth) / 2

    for (let i = 0; i < group.length; i++) {
      const ln: LayoutNode = {
        node: group[i],
        layer: l,
        index: i,
        x: offsetX + i * (cardW + GAP_X),
        y: cy,
        h: layerHeights[l],
      }
      laid.push(ln)
      byId.set(group[i].id, ln)
    }
    cy += layerHeights[l] + GAP_Y
  }

  const edges: LayoutEdge[] = []
  for (const ln of laid) {
    for (const dep of ln.node.deps ?? []) {
      const from = byId.get(dep)
      if (from) edges.push({ from, to: ln })
    }
  }

  const width = cw
  const height = cy - GAP_Y + PAD

  return { laid, edges, width, height, cardW }
}

function statusLabel(status: string) {
  switch (status) {
    case "completed":
      return "DONE"
    case "running":
      return "RUNNING"
    case "failed":
      return "FAILED"
    case "cancelled":
      return "SKIP"
    default:
      return "PENDING"
  }
}

export function DagGraph(props: { nodes?: DagNode[]; ready?: string[] }) {
  const [containerWidth, setContainerWidth] = createSignal(0)
  let ref: HTMLDivElement | undefined

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width))
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
  })

  const layout = createMemo(() => computeLayout(props.nodes ?? [], containerWidth()))
  const readySet = createMemo(() => new Set(props.ready ?? []))

  return (
    <div data-component="dag-graph" ref={ref}>
      <Show when={layout()?.laid.length}>
        <div data-slot="dag-graph-canvas" style={{ width: `${layout().width}px`, height: `${layout().height}px` }}>
          <svg width={layout().width} height={layout().height} data-slot="dag-graph-edges">
            <For each={layout().edges}>
              {(edge) => {
                const cardW = layout().cardW
                const x1 = edge.from.x + cardW / 2
                const y1 = edge.from.y + edge.from.h
                const x2 = edge.to.x + cardW / 2
                const y2 = edge.to.y
                const cy = (y1 + y2) / 2
                return (
                  <path
                    d={`M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`}
                    data-slot="dag-graph-edge"
                    data-status={edge.to.node.status}
                  />
                )
              }}
            </For>
          </svg>
          <For each={layout().laid}>
            {(ln) => (
              <div
                data-slot="dag-graph-card"
                data-status={ln.node.status}
                data-ready={readySet().has(ln.node.id)}
                style={{
                  left: `${ln.x}px`,
                  top: `${ln.y}px`,
                  width: `${layout().cardW}px`,
                  height: `${ln.h}px`,
                }}
              >
                <div data-slot="dag-graph-card-header">
                  <span data-slot="dag-graph-status-dot" />
                  <span data-slot="dag-graph-status-label">{statusLabel(ln.node.status)}</span>
                  <Show when={ln.node.assign && ln.node.assign !== "self"}>
                    <span data-slot="dag-graph-assign">@{ln.node.assign}</span>
                  </Show>
                </div>
                <div data-slot="dag-graph-card-content">{ln.node.content}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
