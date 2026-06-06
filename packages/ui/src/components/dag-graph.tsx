import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
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

const CARD_W = 248
const MIN_CARD_H = 96
const MAX_CARD_H = 178
const GAP_X = 30
const GAP_Y = 72
const PAD_X = 40
const PAD_Y = 34

const HEADER_H = 24
const LINE_H = 18
const CARD_PAD_Y = 22
const CARD_GAP = 8
const CHAR_W = 7.1

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function estimateCardH(content: string | undefined): number {
  const text = content ?? ""
  const textW = Math.max(1, CARD_W - 34)
  const charsPerLine = Math.max(1, Math.floor(textW / CHAR_W))
  const numLines = Math.max(1, Math.ceil(text.length / charsPerLine))
  return clamp(CARD_PAD_Y + HEADER_H + CARD_GAP + numLines * LINE_H, MIN_CARD_H, MAX_CARD_H)
}

function originalIndex(nodes: DagNode[]) {
  return new Map(nodes.map((node, index) => [node.id, index]))
}

export function computeLayout(rawNodes: DagNode[], containerWidth: number) {
  const nodes = rawNodes.filter((n) => n.id && n.status)
  if (nodes.length === 0) return { laid: [] as LayoutNode[], edges: [] as LayoutEdge[], width: 0, height: 0, cardW: 0 }

  const map = new Map(nodes.map((n) => [n.id, n]))
  const original = originalIndex(nodes)

  const layers = new Map<string, number>()
  const visiting = new Set<string>()
  function depth(id: string): number {
    if (layers.has(id)) return layers.get(id)!
    if (visiting.has(id)) {
      layers.set(id, 0)
      return 0
    }
    const node = map.get(id)
    const deps = node?.deps
    if (!node || !Array.isArray(deps) || deps.length === 0) {
      layers.set(id, 0)
      return 0
    }
    visiting.add(id)
    const val = Math.max(...deps.map((d) => depth(d))) + 1
    visiting.delete(id)
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
  const sortedGroups = new Map<number, DagNode[]>()
  const order = new Map<string, number>()

  for (let l = 0; l <= maxLayer; l++) {
    const group = [...(layerGroups.get(l) ?? [])]
    group.sort((a, b) => {
      const avgA = averageDepOrder(a, order, original)
      const avgB = averageDepOrder(b, order, original)
      return avgA - avgB || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0)
    })
    sortedGroups.set(l, group)
    group.forEach((node, index) => order.set(node.id, index))
  }

  const maxGroupSize = Math.max(...[...sortedGroups.values()].map((g) => g.length), 1)
  const minWorldWidth = maxGroupSize * CARD_W + (maxGroupSize - 1) * GAP_X + PAD_X * 2
  const worldWidth = Math.max(containerWidth || 600, minWorldWidth)

  const layerHeights: number[] = []
  for (let l = 0; l <= maxLayer; l++) {
    const group = sortedGroups.get(l) ?? []
    const maxH = Math.max(...group.map((n) => estimateCardH(n.content)), MIN_CARD_H)
    layerHeights.push(maxH)
  }

  const laid: LayoutNode[] = []
  const byId = new Map<string, LayoutNode>()

  let cy = PAD_Y
  for (let l = 0; l <= maxLayer; l++) {
    const group = sortedGroups.get(l) ?? []
    const rowWidth = group.length * CARD_W + Math.max(0, group.length - 1) * GAP_X
    const offsetX = (worldWidth - rowWidth) / 2

    for (let i = 0; i < group.length; i++) {
      const ln: LayoutNode = {
        node: group[i],
        layer: l,
        index: i,
        x: offsetX + i * (CARD_W + GAP_X),
        y: cy,
        h: estimateCardH(group[i].content),
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

  const height = cy - GAP_Y + PAD_Y

  return { laid, edges, width: worldWidth, height, cardW: CARD_W }
}

function averageDepOrder(node: DagNode, layerOrder: Map<string, number>, fallback: Map<string, number>) {
  const deps = node.deps ?? []
  if (deps.length === 0) return fallback.get(node.id) ?? 0
  const values = deps.map((dep) => layerOrder.get(dep) ?? fallback.get(dep) ?? fallback.get(node.id) ?? 0)
  return values.reduce((sum, value) => sum + value, 0) / values.length
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

function statusCounts(nodes: DagNode[]) {
  return {
    completed: nodes.filter((n) => n.status === "completed").length,
    running: nodes.filter((n) => n.status === "running").length,
    failed: nodes.filter((n) => n.status === "failed").length,
    pending: nodes.filter((n) => n.status === "pending").length,
  }
}

export function DagGraph(props: { nodes?: DagNode[]; ready?: string[] }) {
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [scale, setScale] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [dragging, setDragging] = createSignal(false)
  const [hasUserMoved, setHasUserMoved] = createSignal(false)

  const markerId = createUniqueId()
  let ref: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let dragStart: { pointer: { x: number; y: number }; pan: { x: number; y: number } } | undefined

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width))
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
  })

  const nodes = createMemo(() => props.nodes ?? [])
  const layout = createMemo(() => computeLayout(nodes(), containerWidth()))
  const readySet = createMemo(() => new Set(props.ready ?? []))
  const counts = createMemo(() => statusCounts(nodes()))

  createEffect(() => {
    const l = layout()
    if (!viewport || hasUserMoved() || l.width === 0 || l.height === 0) return
    focusActiveNodes()
  })

  function fitView() {
    fitToNodes(layout().laid)
  }

  function focusActiveNodes() {
    const laid = layout().laid
    const running = laid.filter((node) => node.node.status === "running")
    const ready = laid.filter((node) => readySet().has(node.node.id))
    const pending = laid.filter((node) => node.node.status === "pending")
    fitToNodes(
      running.length > 0 ? running : ready.length > 0 ? ready : pending.length > 0 ? pending.slice(0, 3) : laid,
    )
  }

  function fitToNodes(targets: LayoutNode[]) {
    const l = layout()
    if (!viewport || l.width === 0 || l.height === 0 || targets.length === 0) return
    const bounds = viewport.getBoundingClientRect()
    const minX = Math.min(...targets.map((node) => node.x))
    const maxX = Math.max(...targets.map((node) => node.x + l.cardW))
    const minY = Math.min(...targets.map((node) => node.y))
    const maxY = Math.max(...targets.map((node) => node.y + node.h))
    const padding = 72
    const targetW = Math.max(1, maxX - minX + padding * 2)
    const targetH = Math.max(1, maxY - minY + padding * 2)
    const nextScale = clamp(Math.min((bounds.width - 32) / targetW, (bounds.height - 32) / targetH, 1), 0.32, 1.16)
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    setScale(nextScale)
    setPan({
      x: bounds.width / 2 - centerX * nextScale,
      y: bounds.height / 2 - centerY * nextScale,
    })
  }

  function zoomAt(nextScale: number, clientX?: number, clientY?: number) {
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const originX = clientX === undefined ? bounds.width / 2 : clientX - bounds.left
    const originY = clientY === undefined ? bounds.height / 2 : clientY - bounds.top
    const current = scale()
    const next = clamp(nextScale, 0.32, 1.45)
    const currentPan = pan()
    const worldX = (originX - currentPan.x) / current
    const worldY = (originY - currentPan.y) / current
    setScale(next)
    setPan({ x: originX - worldX * next, y: originY - worldY * next })
    setHasUserMoved(true)
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    zoomAt(scale() * factor, event.clientX, event.clientY)
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | undefined
    if (target?.closest("button")) return
    setDragging(true)
    setHasUserMoved(true)
    dragStart = { pointer: { x: event.clientX, y: event.clientY }, pan: pan() }
    viewport?.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent) {
    if (!dragging() || !dragStart) return
    setPan({
      x: dragStart.pan.x + event.clientX - dragStart.pointer.x,
      y: dragStart.pan.y + event.clientY - dragStart.pointer.y,
    })
  }

  function handlePointerUp(event: PointerEvent) {
    setDragging(false)
    dragStart = undefined
    viewport?.releasePointerCapture(event.pointerId)
  }

  return (
    <div data-component="dag-graph" ref={ref}>
      <Show when={layout()?.laid.length}>
        <div data-slot="dag-graph-toolbar">
          <div data-slot="dag-graph-stats">
            <span data-slot="dag-graph-stat" data-kind="done">
              {counts().completed} done
            </span>
            <span data-slot="dag-graph-stat" data-kind="running">
              {counts().running} running
            </span>
            <span data-slot="dag-graph-stat" data-kind="pending">
              {counts().pending} pending
            </span>
            <Show when={counts().failed > 0}>
              <span data-slot="dag-graph-stat" data-kind="failed">
                {counts().failed} failed
              </span>
            </Show>
          </div>
          <div data-slot="dag-graph-controls">
            <button type="button" onClick={focusActiveNodes}>
              Focus
            </button>
            <button type="button" onClick={fitView}>
              Fit
            </button>
            <button type="button" onClick={() => zoomAt(scale() * 0.86)}>
              −
            </button>
            <span>{Math.round(scale() * 100)}%</span>
            <button type="button" onClick={() => zoomAt(scale() * 1.16)}>
              +
            </button>
          </div>
        </div>
        <div
          data-slot="dag-graph-viewport"
          data-dragging={dragging()}
          ref={viewport}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDblClick={focusActiveNodes}
        >
          <div
            data-slot="dag-graph-stage"
            style={{
              width: `${layout().width}px`,
              height: `${layout().height}px`,
              transform: `translate(${pan().x}px, ${pan().y}px) scale(${scale()})`,
            }}
          >
            <svg width={layout().width} height={layout().height} data-slot="dag-graph-edges">
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="5"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" data-slot="dag-graph-arrow" />
                </marker>
              </defs>
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
                      marker-end={`url(#${markerId})`}
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
                  <div data-slot="dag-graph-card-content" title={ln.node.content}>
                    {ln.node.content}
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div data-slot="dag-graph-hint">Drag to pan · Ctrl/⌘ + wheel to zoom · Double-click to focus</div>
      </Show>
    </div>
  )
}
