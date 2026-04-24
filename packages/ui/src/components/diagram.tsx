import { For, Show, createMemo, createSignal, onMount, onCleanup } from "solid-js"
import "./diagram.css"

interface NormalizedNode {
  label: string
  group?: string
  description?: string
  style?: string
}

interface NormalizedEdge {
  from: string
  to: string
  label?: string
}

interface NormalizedCell {
  value: string
  sentiment?: string
}

interface NormalizedStep {
  from?: string
  to?: string
  action: string
  note?: string
  style?: string
}

interface NormalizedEvent {
  date: string
  title: string
  description?: string
  style?: string
}

interface NormalizedTreeNode {
  label: string
  description?: string
  style?: string
  children: NormalizedTreeNode[]
}

interface GraphDocument {
  type: "graph"
  title: string
  direction?: string
  nodes: NormalizedNode[]
  edges: NormalizedEdge[]
}

interface CompareDocument {
  type: "compare"
  title: string
  headers: string[]
  rows: NormalizedCell[][]
  caption?: string
}

interface SequenceDocument {
  type: "sequence"
  title: string
  actors: string[]
  steps: NormalizedStep[]
}

interface TimelineDocument {
  type: "timeline"
  title: string
  events: NormalizedEvent[]
}

interface TreeDocument {
  type: "tree"
  title: string
  root: NormalizedTreeNode
}

interface ChartSeries {
  name: string
  values: number[]
}

interface ChartSegment {
  label: string
  value: number
}

interface ChartDocument {
  type: "chart"
  title: string
  variant: "bar" | "line" | "pie"
  labels: string[]
  series: ChartSeries[]
  segments: ChartSegment[]
}

type DiagramDocument =
  | GraphDocument
  | CompareDocument
  | SequenceDocument
  | TimelineDocument
  | TreeDocument
  | ChartDocument

// ── Graph layout ──

interface LayoutNode {
  node: NormalizedNode
  x: number
  y: number
  w: number
  h: number
  layer: number
  slot: number
}

type GraphDirection = "TB" | "LR"
type EdgeKind = "forward" | "backward" | "same-layer"

interface LayoutEdge {
  from: LayoutNode
  to: LayoutNode
  label?: string
  kind: EdgeKind
  lane: number
}

interface GroupRect {
  label: string
  x: number
  y: number
  w: number
  h: number
}

interface GraphLayout {
  laid: LayoutNode[]
  edges: LayoutEdge[]
  groups: GroupRect[]
  width: number
  height: number
  cardW: number
  direction: GraphDirection
  nodeBounds: { left: number; top: number; right: number; bottom: number }
  loopStart: number
}

interface IndexedEdge {
  from: number
  to: number
  label?: string
}

const CARD_PAD_X = 14
const CARD_PAD_Y = 10
const LABEL_LINE_H = 18
const DESC_LINE_H = 15
const CHAR_W_LATIN = 7
const CHAR_W_CJK = 12
const MAX_CARD_W = 192
const MIN_CARD_W = 100
const GAP_X = 24
const GAP_Y = 40
const PAD = 16
const GROUP_PAD = 10
const GROUP_LABEL_H = 18
const EDGE_ARROW_ID = "diagram-graph-arrowhead"
const LOOP_EDGE_BASE = 28
const LOOP_EDGE_GAP = 34

function estimateTextWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    w += ch.charCodeAt(0) > 0x2e7f ? CHAR_W_CJK : CHAR_W_LATIN
  }
  return w
}

function estimateNodeH(node: NormalizedNode, cardW: number): number {
  const textW = Math.max(1, cardW - 2 * CARD_PAD_X)
  const labelW = estimateTextWidth(node.label)
  const labelLines = Math.max(1, Math.ceil(labelW / textW))
  let h = 2 * CARD_PAD_Y + labelLines * LABEL_LINE_H
  if (node.description) {
    const descW = estimateTextWidth(node.description)
    const descLines = Math.max(1, Math.ceil(descW / textW))
    h += descLines * DESC_LINE_H + 2
  }
  return h
}

function normalizeGraphDirection(direction?: string): GraphDirection {
  return direction === "LR" ? "LR" : "TB"
}

function topoSort(nodeCount: number, edges: IndexedEdge[]) {
  const indegree = new Array<number>(nodeCount).fill(0)
  const adj: number[][] = Array.from({ length: nodeCount }, () => [])
  for (const edge of edges) {
    adj[edge.from].push(edge.to)
    indegree[edge.to] += 1
  }

  const queue: number[] = []
  for (let i = 0; i < nodeCount; i++) {
    if (indegree[i] === 0) queue.push(i)
  }

  const order: number[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const next of adj[node]) {
      indegree[next] -= 1
      if (indegree[next] === 0) queue.push(next)
    }
  }

  return { order, acyclic: order.length === nodeCount }
}

function computeGraphLayers(nodeCount: number, edges: IndexedEdge[]): number[] {
  const fullTopo = topoSort(nodeCount, edges)
  const layeringEdges = fullTopo.acyclic ? edges : edges.filter((edge) => edge.from < edge.to)
  const order = fullTopo.acyclic ? fullTopo.order : Array.from({ length: nodeCount }, (_, i) => i)
  const incoming: number[][] = Array.from({ length: nodeCount }, () => [])

  for (const edge of layeringEdges) {
    incoming[edge.to].push(edge.from)
  }

  const layers = new Array<number>(nodeCount).fill(0)
  for (const node of order) {
    const deps = incoming[node]
    if (deps.length === 0) continue
    layers[node] = Math.max(...deps.map((dep) => layers[dep])) + 1
  }

  return layers
}

function assignEdgeLanes(edges: Array<{ fromLayer: number; toLayer: number }>) {
  const laneKeys = edges
    .map((edge, index) => ({
      index,
      kind: edge.toLayer > edge.fromLayer ? "forward" : edge.toLayer < edge.fromLayer ? "backward" : "same-layer",
      span: Math.abs(edge.toLayer - edge.fromLayer),
    }))
    .filter((edge) => edge.kind !== "forward")
    .sort((a, b) => b.span - a.span || a.index - b.index)

  const lanes = new Array<number>(edges.length).fill(-1)
  laneKeys.forEach((edge, lane) => {
    lanes[edge.index] = lane
  })
  return lanes
}

function computeGroups(nodes: NormalizedNode[], laid: LayoutNode[]): GroupRect[] {
  const groups: GroupRect[] = []
  const groupMap = new Map<string, number[]>()

  for (let i = 0; i < nodes.length; i++) {
    const group = nodes[i].group
    if (!group) continue
    const indices = groupMap.get(group) ?? []
    indices.push(i)
    groupMap.set(group, indices)
  }

  for (const [label, indices] of groupMap) {
    if (indices.length < 2) continue
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const index of indices) {
      const node = laid[index]
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x + node.w)
      maxY = Math.max(maxY, node.y + node.h)
    }

    groups.push({
      label,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD - GROUP_LABEL_H,
      w: maxX - minX + 2 * GROUP_PAD,
      h: maxY - minY + 2 * GROUP_PAD + GROUP_LABEL_H,
    })
  }

  return groups
}

export function computeGraphLayout(doc: GraphDocument, containerWidth: number): GraphLayout {
  const nodes = doc.nodes
  const direction = normalizeGraphDirection(doc.direction)
  if (nodes.length === 0) {
    return {
      laid: [],
      edges: [],
      groups: [],
      width: 0,
      height: 0,
      cardW: 0,
      direction,
      nodeBounds: { left: 0, top: 0, right: 0, bottom: 0 },
      loopStart: 0,
    }
  }

  const labelIndex = new Map(nodes.map((node, index) => [node.label, index]))
  const indexedEdges: IndexedEdge[] = []
  for (const edge of doc.edges) {
    const from = labelIndex.get(edge.from)
    const to = labelIndex.get(edge.to)
    if (from === undefined || to === undefined) continue
    indexedEdges.push({ from, to, label: edge.label })
  }

  const layers = computeGraphLayers(nodes.length, indexedEdges)
  const layerGroups = new Map<number, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const layer = layers[i]
    const group = layerGroups.get(layer) ?? []
    group.push(i)
    layerGroups.set(layer, group)
  }

  const maxLayer = Math.max(0, ...layerGroups.keys())
  const layerCount = maxLayer + 1
  const maxGroupSize = Math.max(1, ...[...layerGroups.values()].map((group) => group.length))
  const cw = containerWidth || 600
  const cardW =
    direction === "LR"
      ? Math.max(MIN_CARD_W, Math.min(MAX_CARD_W, Math.floor((cw - 2 * PAD - (layerCount - 1) * GAP_X) / layerCount)))
      : Math.max(
          MIN_CARD_W,
          Math.min(MAX_CARD_W, Math.floor((cw - 2 * PAD - (maxGroupSize - 1) * GAP_X) / maxGroupSize)),
        )

  const nodeHeights = nodes.map((node) => estimateNodeH(node, cardW))
  const laid: LayoutNode[] = new Array(nodes.length)

  if (direction === "LR") {
    const columnHeights = new Array<number>(layerCount).fill(0)
    for (let layer = 0; layer <= maxLayer; layer++) {
      const group = layerGroups.get(layer) ?? []
      columnHeights[layer] = group.reduce((sum, index, slot) => sum + nodeHeights[index] + (slot > 0 ? GAP_Y : 0), 0)
    }

    const nodeAreaHeight = Math.max(...columnHeights)
    const rowWidth = layerCount * cardW + (layerCount - 1) * GAP_X
    const width = Math.max(cw, rowWidth + 2 * PAD)

    for (let layer = 0; layer <= maxLayer; layer++) {
      const group = layerGroups.get(layer) ?? []
      const totalHeight = columnHeights[layer]
      const offsetY = PAD + (nodeAreaHeight - totalHeight) / 2
      let currentY = offsetY
      const x = (width - rowWidth) / 2 + layer * (cardW + GAP_X)
      group.forEach((index, slot) => {
        laid[index] = {
          node: nodes[index],
          x,
          y: currentY,
          w: cardW,
          h: nodeHeights[index],
          layer,
          slot,
        }
        currentY += nodeHeights[index] + GAP_Y
      })
    }

    const provisionalEdges = indexedEdges.map((edge) => ({ fromLayer: layers[edge.from], toLayer: layers[edge.to] }))
    const lanes = assignEdgeLanes(provisionalEdges)
    const loopLaneCount = lanes.filter((lane) => lane >= 0).length
    const nodeBounds = {
      left: Math.min(...laid.map((node) => node.x)),
      top: Math.min(...laid.map((node) => node.y)),
      right: Math.max(...laid.map((node) => node.x + node.w)),
      bottom: Math.max(...laid.map((node) => node.y + node.h)),
    }
    const loopStart = nodeBounds.bottom + LOOP_EDGE_BASE
    const height = loopLaneCount > 0 ? loopStart + (loopLaneCount - 1) * LOOP_EDGE_GAP + PAD : nodeBounds.bottom + PAD

    const edges = indexedEdges.map((edge, index) => {
      const from = laid[edge.from]
      const to = laid[edge.to]
      const fromLayer = layers[edge.from]
      const toLayer = layers[edge.to]
      const kind: EdgeKind = toLayer > fromLayer ? "forward" : toLayer < fromLayer ? "backward" : "same-layer"
      return { from, to, label: edge.label, kind, lane: lanes[index] }
    })

    return {
      laid,
      edges,
      groups: computeGroups(nodes, laid),
      width,
      height,
      cardW,
      direction,
      nodeBounds,
      loopStart,
    }
  }

  const layerHeights = new Array<number>(layerCount).fill(0)
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) ?? []
    layerHeights[layer] = Math.max(0, ...group.map((index) => nodeHeights[index]))
  }

  let maxRowWidth = 0
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) ?? []
    const rowWidth = group.length * cardW + Math.max(0, group.length - 1) * GAP_X + 2 * PAD
    maxRowWidth = Math.max(maxRowWidth, rowWidth)
  }
  const width = Math.max(cw, maxRowWidth)

  let currentY = PAD
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) ?? []
    const rowWidth = group.length * cardW + Math.max(0, group.length - 1) * GAP_X
    const offsetX = (width - rowWidth) / 2
    group.forEach((index, slot) => {
      laid[index] = {
        node: nodes[index],
        x: offsetX + slot * (cardW + GAP_X),
        y: currentY,
        w: cardW,
        h: layerHeights[layer],
        layer,
        slot,
      }
    })
    currentY += layerHeights[layer] + GAP_Y
  }

  const nodeBounds = {
    left: Math.min(...laid.map((node) => node.x)),
    top: Math.min(...laid.map((node) => node.y)),
    right: Math.max(...laid.map((node) => node.x + node.w)),
    bottom: Math.max(...laid.map((node) => node.y + node.h)),
  }

  const height = currentY - GAP_Y + PAD
  const edges = indexedEdges.map((edge) => {
    const from = laid[edge.from]
    const to = laid[edge.to]
    const fromLayer = layers[edge.from]
    const toLayer = layers[edge.to]
    const kind: EdgeKind = toLayer > fromLayer ? "forward" : toLayer < fromLayer ? "backward" : "same-layer"
    return { from, to, label: edge.label, kind, lane: -1 }
  })

  return {
    laid,
    edges,
    groups: computeGroups(nodes, laid),
    width,
    height,
    cardW,
    direction,
    nodeBounds,
    loopStart: nodeBounds.bottom,
  }
}

function getGraphEdgePath(edge: LayoutEdge, layout: GraphLayout) {
  if (layout.direction === "LR") {
    if (edge.kind === "forward") {
      const x1 = edge.from.x + edge.from.w
      const y1 = edge.from.y + edge.from.h / 2
      const x2 = edge.to.x - 8
      const y2 = edge.to.y + edge.to.h / 2
      const cx = (x1 + x2) / 2
      return {
        path: `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`,
        labelX: cx,
        labelY: (y1 + y2) / 2,
      }
    }

    const x1 = edge.from.x + edge.from.w / 2
    const y1 = edge.from.y + edge.from.h
    const x2 = edge.to.x + edge.to.w / 2
    const y2 = edge.to.y + edge.to.h
    const laneY = layout.loopStart + edge.lane * LOOP_EDGE_GAP
    const midX = (x1 + x2) / 2
    return {
      path: `M${x1},${y1} C${x1},${laneY} ${midX},${laneY} ${midX},${laneY} S${x2},${laneY} ${x2},${y2}`,
      labelX: midX,
      labelY: laneY,
    }
  }

  const x1 = edge.from.x + edge.from.w / 2
  const y1 = edge.from.y + edge.from.h
  const x2 = edge.to.x + edge.to.w / 2
  const y2 = edge.to.y - 8
  const cy = (y1 + y2) / 2
  return {
    path: `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: cy,
  }
}

export function DiagramGraph(props: { document: GraphDocument }) {
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [overflowX, setOverflowX] = createSignal(false)
  const [overflowY, setOverflowY] = createSignal(false)
  let ref: HTMLDivElement | undefined
  let scrollRef: HTMLDivElement | undefined

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width)
      checkOverflow()
    })
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
  })

  function checkOverflow() {
    if (!scrollRef) return
    setOverflowX(scrollRef.scrollWidth > scrollRef.clientWidth + 2)
    setOverflowY(scrollRef.scrollHeight > scrollRef.clientHeight + 2)
  }

  function handleScroll() {
    if (!scrollRef) return
    const atRight = scrollRef.scrollLeft + scrollRef.clientWidth >= scrollRef.scrollWidth - 4
    const atBottom = scrollRef.scrollTop + scrollRef.clientHeight >= scrollRef.scrollHeight - 4
    setOverflowX(!atRight && scrollRef.scrollWidth > scrollRef.clientWidth + 2)
    setOverflowY(!atBottom && scrollRef.scrollHeight > scrollRef.clientHeight + 2)
  }

  const layout = createMemo(() => {
    const l = computeGraphLayout(props.document, containerWidth())
    queueMicrotask(checkOverflow)
    return l
  })

  return (
    <div data-component="diagram-graph" ref={ref}>
      <Show when={layout().laid.length > 0}>
        <div
          data-slot="diagram-scroll"
          data-overflow-x={overflowX()}
          data-overflow-y={overflowY()}
          ref={scrollRef}
          onScroll={handleScroll}
        >
          <div data-slot="diagram-canvas" style={{ width: `${layout().width}px`, height: `${layout().height}px` }}>
            <For each={layout().groups}>
              {(g) => (
                <>
                  <div
                    data-slot="diagram-group-bg"
                    style={{ left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` }}
                  />
                  <div
                    data-slot="diagram-group-label"
                    style={{ left: `${g.x}px`, top: `${g.y + 4}px`, width: `${g.w}px` }}
                  >
                    {g.label}
                  </div>
                </>
              )}
            </For>
            <svg width={layout().width} height={layout().height} data-slot="diagram-edges">
              <defs>
                <marker id={EDGE_ARROW_ID} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                  <path
                    d="M1,1 L9,4 L1,7"
                    fill="none"
                    stroke="var(--text-weaker)"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </marker>
              </defs>
              <For each={layout().edges}>
                {(edge) => {
                  const geometry = getGraphEdgePath(edge, layout())
                  return (
                    <>
                      <path d={geometry.path} data-slot="diagram-edge" marker-end={`url(#${EDGE_ARROW_ID})`} />
                      <Show when={edge.label}>
                        {(label) => {
                          const tw = estimateTextWidth(label()) * 0.62 + 12
                          return (
                            <>
                              <rect
                                data-slot="diagram-edge-label-bg"
                                x={geometry.labelX - tw / 2}
                                y={geometry.labelY - 8}
                                width={tw}
                                height={16}
                              />
                              <text x={geometry.labelX} y={geometry.labelY} data-slot="diagram-edge-label">
                                {label()}
                              </text>
                            </>
                          )
                        }}
                      </Show>
                    </>
                  )
                }}
              </For>
            </svg>
            <For each={layout().laid}>
              {(ln) => (
                <div
                  data-slot="diagram-node"
                  data-style={ln.node.style ?? "default"}
                  style={{ left: `${ln.x}px`, top: `${ln.y}px`, width: `${ln.w}px`, height: `${ln.h}px` }}
                >
                  <div data-slot="diagram-node-label">{ln.node.label}</div>
                  <Show when={ln.node.description}>
                    <div data-slot="diagram-node-desc">{ln.node.description}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Compare table ──

export function DiagramCompare(props: { document: CompareDocument }) {
  return (
    <div data-component="diagram-compare">
      <table data-slot="diagram-table">
        <thead>
          <tr>
            <For each={props.document.headers}>{(h) => <th data-slot="diagram-th">{h}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.document.rows}>
            {(row) => (
              <tr>
                <For each={row}>
                  {(cell, i) => (
                    <td data-slot={i() === 0 ? "diagram-th" : "diagram-td"} data-sentiment={cell.sentiment}>
                      {cell.value}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={props.document.caption}>
        <div data-slot="diagram-caption">{props.document.caption}</div>
      </Show>
    </div>
  )
}

// ── Sequence diagram ──

const SEQ_ACTOR_H = 32
const SEQ_ACTOR_GAP = 16
const SEQ_STEP_H = 40
const SEQ_TOP_PAD = 8
const SEQ_STEP_PAD = 12
const SEQ_SIDE_PAD = 32
const SEQ_ARROW_ID = "diagram-sequence-arrowhead"

function estimateActorWidth(label: string): number {
  return Math.max(60, estimateTextWidth(label) * 0.72 + 28)
}

function computeSequenceLayout(doc: SequenceDocument, containerWidth: number) {
  const actors = doc.actors
  const steps = doc.steps
  const hasActors = actors.length > 0 && steps.some((s) => s.from || s.to)

  if (!hasActors) {
    return {
      hasActors: false as const,
      actors: [] as string[],
      steps,
      width: containerWidth || 400,
      height: SEQ_TOP_PAD + SEQ_ACTOR_H + steps.length * SEQ_STEP_H + SEQ_STEP_PAD,
    }
  }

  const actorWidths = actors.map(estimateActorWidth)
  const totalLabelWidth = actorWidths.reduce((sum, width) => sum + width, 0)
  const totalGaps = Math.max(0, actors.length - 1) * SEQ_ACTOR_GAP
  const minWidth = totalLabelWidth + totalGaps + 2 * SEQ_SIDE_PAD
  const width = Math.max(containerWidth || 400, minWidth)

  const actorXs: number[] = []
  let currentX = SEQ_SIDE_PAD
  for (let i = 0; i < actors.length; i++) {
    const actorWidth = actorWidths[i]
    actorXs.push(currentX + actorWidth / 2)
    currentX += actorWidth + SEQ_ACTOR_GAP
  }

  const bodyTop = SEQ_TOP_PAD + SEQ_ACTOR_H + SEQ_ACTOR_GAP
  const height = bodyTop + steps.length * SEQ_STEP_H + SEQ_STEP_PAD

  return { hasActors: true as const, actors, actorWidths, actorXs, steps, width, height, bodyTop }
}

export function DiagramSequence(props: { document: SequenceDocument }) {
  const [containerWidth, setContainerWidth] = createSignal(0)
  let ref: HTMLDivElement | undefined

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width))
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
  })

  const layout = createMemo(() => computeSequenceLayout(props.document, containerWidth()))

  return (
    <div data-component="diagram-sequence" ref={ref}>
      <Show when={layout().hasActors} fallback={<TimelineView steps={layout().steps} />}>
        {(_) => {
          const l = layout() as ReturnType<typeof computeSequenceLayout> & { hasActors: true }
          const actorIndex = new Map(l.actors.map((a, i) => [a, i]))
          return (
            <div data-slot="sequence-scroll">
              <div data-slot="sequence-canvas" style={{ width: `${l.width}px`, height: `${l.height}px` }}>
                <svg width={l.width} height={l.height} style={{ position: "absolute", top: 0, left: 0 }}>
                  <defs>
                    <marker id={SEQ_ARROW_ID} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                      <path d="M0,0 L8,3 L0,6" fill="none" stroke="var(--text-weak)" stroke-width="1.2" />
                    </marker>
                  </defs>
                  <For each={l.actorXs}>
                    {(x) => (
                      <line x1={x} y1={SEQ_TOP_PAD + SEQ_ACTOR_H} x2={x} y2={l.height} data-slot="sequence-lifeline" />
                    )}
                  </For>
                  <For each={l.steps}>
                    {(step, si) => {
                      const fi = step.from ? actorIndex.get(step.from) : undefined
                      const ti = step.to ? actorIndex.get(step.to) : undefined
                      if (fi === undefined || ti === undefined) return null
                      const y = l.bodyTop + si() * SEQ_STEP_H + SEQ_STEP_H / 2
                      const x1 = l.actorXs[fi]
                      const x2 = l.actorXs[ti]
                      const labelX = (x1 + x2) / 2
                      const align = x1 < x2 ? "start" : "end"
                      return (
                        <>
                          <line
                            x1={x1}
                            y1={y}
                            x2={x2}
                            y2={y}
                            data-slot="sequence-arrow"
                            data-style={step.style}
                            marker-end={`url(#${SEQ_ARROW_ID})`}
                          />
                          <text
                            x={labelX}
                            y={y - 6}
                            data-slot="sequence-arrow-label"
                            text-anchor={x1 === x2 ? "start" : "middle"}
                            dx={x1 === x2 ? 8 : 0}
                          >
                            {step.action}
                          </text>
                          <Show when={step.note}>
                            <text x={labelX} y={y + 14} data-slot="sequence-note" text-anchor={align}>
                              {step.note}
                            </text>
                          </Show>
                        </>
                      )
                    }}
                  </For>
                </svg>
                <For each={l.actors}>
                  {(actor, i) => (
                    <div
                      data-slot="sequence-actor"
                      style={{ left: `${l.actorXs[i()]}px`, top: `${SEQ_TOP_PAD}px`, width: `${l.actorWidths[i()]}px` }}
                    >
                      {actor}
                    </div>
                  )}
                </For>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

function TimelineView(props: { steps: NormalizedStep[] }) {
  return (
    <div data-component="diagram-sequence">
      <svg width="100%" height={props.steps.length * SEQ_STEP_H + SEQ_STEP_PAD * 2} style={{ display: "block" }}>
        <For each={props.steps}>
          {(step, i) => {
            const y = SEQ_STEP_PAD + i() * SEQ_STEP_H + SEQ_STEP_H / 2
            return (
              <>
                <rect data-slot="sequence-step-bg" x={PAD} y={y - 14} width="calc(100% - 24px)" height={28} />
                <text x="50%" y={y} data-slot="sequence-step-label">
                  {step.action}
                </text>
              </>
            )
          }}
        </For>
      </svg>
    </div>
  )
}

// ── Timeline ──

const TL_CARD_W = 168
const TL_CARD_GAP = 16
const TL_AXIS_Y = 28
const TL_PAD = 20

export function DiagramTimeline(props: { document: TimelineDocument }) {
  const [overflow, setOverflow] = createSignal(false)
  let scrollRef: HTMLDivElement | undefined

  const events = () => props.document.events
  const totalWidth = () => events().length * TL_CARD_W + (events().length - 1) * TL_CARD_GAP + 2 * TL_PAD

  function checkOverflow() {
    if (!scrollRef) return
    const atEnd = scrollRef.scrollLeft + scrollRef.clientWidth >= scrollRef.scrollWidth - 4
    setOverflow(!atEnd && scrollRef.scrollWidth > scrollRef.clientWidth + 2)
  }

  onMount(() => {
    queueMicrotask(checkOverflow)
  })

  return (
    <div data-component="diagram-timeline">
      <div data-slot="timeline-scroll" data-overflow={overflow()} ref={scrollRef} onScroll={checkOverflow}>
        <div data-slot="timeline-canvas" style={{ width: `${totalWidth()}px` }}>
          <svg width={totalWidth()} height={TL_AXIS_Y + 6} data-slot="timeline-axis-svg">
            <line x1={TL_PAD} y1={TL_AXIS_Y} x2={totalWidth() - TL_PAD} y2={TL_AXIS_Y} data-slot="timeline-axis" />
            <For each={events()}>
              {(_, i) => {
                const cx = TL_PAD + i() * (TL_CARD_W + TL_CARD_GAP) + TL_CARD_W / 2
                return <circle cx={cx} cy={TL_AXIS_Y} r={3.5} data-slot="timeline-dot" />
              }}
            </For>
          </svg>
          <div data-slot="timeline-cards">
            <For each={events()}>
              {(event) => (
                <div data-slot="timeline-card" data-style={event.style ?? "default"}>
                  <Show when={event.date}>
                    <div data-slot="timeline-date">{event.date}</div>
                  </Show>
                  <div data-slot="timeline-title">{event.title}</div>
                  <Show when={event.description}>
                    <div data-slot="timeline-desc">{event.description}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Tree ──

function TreeNode(props: { node: NormalizedTreeNode; last: boolean; depth: number }) {
  return (
    <div data-slot="tree-item" data-last={props.last} data-depth={props.depth}>
      <div data-slot="tree-node-row">
        <span data-slot="tree-branch" />
        <span data-slot="tree-label">{props.node.label}</span>
        <Show when={props.node.description}>
          <span data-slot="tree-desc">{props.node.description}</span>
        </Show>
      </div>
      <Show when={props.node.children.length > 0}>
        <div data-slot="tree-children">
          <For each={props.node.children}>
            {(child, i) => (
              <TreeNode node={child} last={i() === props.node.children.length - 1} depth={props.depth + 1} />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function DiagramTree(props: { document: TreeDocument }) {
  return (
    <div data-component="diagram-tree">
      <div data-slot="tree-root-row">
        <span data-slot="tree-root-icon">◆</span>
        <span data-slot="tree-label">{props.document.root.label}</span>
        <Show when={props.document.root.description}>
          <span data-slot="tree-desc">{props.document.root.description}</span>
        </Show>
      </div>
      <Show when={props.document.root.children.length > 0}>
        <div data-slot="tree-children" data-root>
          <For each={props.document.root.children}>
            {(child, i) => <TreeNode node={child} last={i() === props.document.root.children.length - 1} depth={1} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── Chart ──

const CHART_COLORS = [
  "var(--surface-brand-base)",
  "#34d399",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#64748b",
]

const CHART_PAD = { top: 16, right: 16, bottom: 32, left: 48 }
const CHART_H = 220

function chartYAxis(max: number): { ticks: number[]; ceil: number } {
  if (max <= 0) return { ticks: [0], ceil: 1 }
  const rawStep = max / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const candidates = [1, 2, 2.5, 5, 10]
  const step = candidates.map((c) => c * magnitude).find((s) => s >= rawStep) ?? rawStep
  const ceil = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= ceil; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { ticks, ceil }
}

function formatTickValue(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`
  return String(v)
}

export function DiagramChart(props: { document: ChartDocument }) {
  const doc = () => props.document
  return (
    <div data-component="diagram-chart">
      <Show when={doc().variant === "bar"}>
        <ChartBar labels={doc().labels} series={doc().series} />
      </Show>
      <Show when={doc().variant === "line"}>
        <ChartLine labels={doc().labels} series={doc().series} />
      </Show>
      <Show when={doc().variant === "pie"}>
        <ChartPie segments={doc().segments} />
      </Show>
      <Show when={doc().series.length > 1 && doc().variant !== "pie"}>
        <div data-slot="chart-legend">
          <For each={doc().series}>
            {(s, i) => (
              <div data-slot="chart-legend-item">
                <span data-slot="chart-legend-swatch" style={{ background: CHART_COLORS[i() % CHART_COLORS.length] }} />
                {s.name}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ChartBar(props: { labels: string[]; series: ChartSeries[] }) {
  const [width, setWidth] = createSignal(500)
  let ref: HTMLDivElement | undefined

  onMount(() => {
    if (!ref) return
    setWidth(ref.clientWidth)
    const obs = new ResizeObserver((e) => setWidth(e[0].contentRect.width))
    obs.observe(ref)
    onCleanup(() => obs.disconnect())
  })

  const layout = createMemo(() => {
    const w = width()
    const plotW = w - CHART_PAD.left - CHART_PAD.right
    const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
    const allValues = props.series.flatMap((s) => s.values)
    const max = Math.max(...allValues, 0)
    const { ticks, ceil } = chartYAxis(max)
    const n = props.labels.length
    const seriesCount = props.series.length
    const groupW = plotW / Math.max(n, 1)
    const groupPad = Math.max(groupW * 0.2, 4)
    const barSlotW = (groupW - groupPad) / seriesCount
    const barW = Math.min(barSlotW * 0.85, 40)
    return { w, plotW, plotH, ticks, ceil, n, groupW, groupPad, barSlotW, barW, seriesCount }
  })

  return (
    <div ref={ref} data-slot="chart-area">
      <svg width={width()} height={CHART_H}>
        <For each={layout().ticks}>
          {(tick) => {
            const y = CHART_PAD.top + layout().plotH * (1 - tick / layout().ceil)
            return (
              <>
                <line x1={CHART_PAD.left} y1={y} x2={width() - CHART_PAD.right} y2={y} data-slot="chart-grid" />
                <text x={CHART_PAD.left - 6} y={y} data-slot="chart-y-label">
                  {formatTickValue(tick)}
                </text>
              </>
            )
          }}
        </For>
        <For each={props.labels}>
          {(label, li) => {
            const gx = () => CHART_PAD.left + li() * layout().groupW
            return (
              <>
                <For each={props.series}>
                  {(series, si) => {
                    const val = () => series.values[li()] ?? 0
                    const barH = () => (val() / layout().ceil) * layout().plotH
                    const x = () =>
                      gx() + layout().groupPad / 2 + si() * layout().barSlotW + (layout().barSlotW - layout().barW) / 2
                    const y = () => CHART_PAD.top + layout().plotH - barH()
                    return (
                      <>
                        <rect
                          x={x()}
                          y={y()}
                          width={layout().barW}
                          height={barH()}
                          rx={2}
                          fill={CHART_COLORS[si() % CHART_COLORS.length]}
                          data-slot="chart-bar"
                        />
                        <text x={x() + layout().barW / 2} y={y() - 4} data-slot="chart-bar-value">
                          {formatTickValue(val())}
                        </text>
                      </>
                    )
                  }}
                </For>
                <text x={gx() + layout().groupW / 2} y={CHART_H - CHART_PAD.bottom + 16} data-slot="chart-x-label">
                  {label}
                </text>
              </>
            )
          }}
        </For>
      </svg>
    </div>
  )
}

function ChartLine(props: { labels: string[]; series: ChartSeries[] }) {
  const [width, setWidth] = createSignal(500)
  let ref: HTMLDivElement | undefined

  onMount(() => {
    if (!ref) return
    setWidth(ref.clientWidth)
    const obs = new ResizeObserver((e) => setWidth(e[0].contentRect.width))
    obs.observe(ref)
    onCleanup(() => obs.disconnect())
  })

  const layout = createMemo(() => {
    const w = width()
    const plotW = w - CHART_PAD.left - CHART_PAD.right
    const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
    const allValues = props.series.flatMap((s) => s.values)
    const max = Math.max(...allValues, 0)
    const { ticks, ceil } = chartYAxis(max)
    const n = props.labels.length
    const stepX = n > 1 ? plotW / (n - 1) : 0
    return { w, plotW, plotH, ticks, ceil, n, stepX }
  })

  function pointX(i: number) {
    return CHART_PAD.left + i * layout().stepX
  }

  function pointY(v: number) {
    return CHART_PAD.top + layout().plotH * (1 - v / layout().ceil)
  }

  function polyline(values: number[]): string {
    return values.map((v, i) => `${pointX(i)},${pointY(v)}`).join(" ")
  }

  return (
    <div ref={ref} data-slot="chart-area">
      <svg width={width()} height={CHART_H}>
        <For each={layout().ticks}>
          {(tick) => {
            const y = pointY(tick)
            return (
              <>
                <line x1={CHART_PAD.left} y1={y} x2={width() - CHART_PAD.right} y2={y} data-slot="chart-grid" />
                <text x={CHART_PAD.left - 6} y={y} data-slot="chart-y-label">
                  {formatTickValue(tick)}
                </text>
              </>
            )
          }}
        </For>
        <For each={props.series}>
          {(series, si) => {
            const color = () => CHART_COLORS[si() % CHART_COLORS.length]
            return (
              <>
                <polyline
                  points={polyline(series.values)}
                  fill="none"
                  stroke={color()}
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
                <For each={series.values}>
                  {(v, i) => (
                    <circle
                      cx={pointX(i())}
                      cy={pointY(v)}
                      r={3.5}
                      fill={color()}
                      stroke="var(--surface-base)"
                      stroke-width="2"
                    />
                  )}
                </For>
              </>
            )
          }}
        </For>
        <For each={props.labels}>
          {(label, i) => (
            <text x={pointX(i())} y={CHART_H - CHART_PAD.bottom + 16} data-slot="chart-x-label">
              {label}
            </text>
          )}
        </For>
      </svg>
    </div>
  )
}

function ChartPie(props: { segments: ChartSegment[] }) {
  const total = () => props.segments.reduce((sum, s) => sum + s.value, 0)
  const R = 80
  const IR = 48
  const CX = 110
  const CY = 100
  const H = 200

  const slices = createMemo(() => {
    const t = total()
    if (t <= 0) return []
    let angle = -Math.PI / 2
    return props.segments.map((seg, i) => {
      const sweep = (seg.value / t) * 2 * Math.PI
      const s = angle
      const e = angle + sweep
      angle = e
      const large = sweep > Math.PI ? 1 : 0

      const isx = CX + IR * Math.cos(s)
      const isy = CY + IR * Math.sin(s)
      const iex = CX + IR * Math.cos(e)
      const iey = CY + IR * Math.sin(e)
      const oex = CX + R * Math.cos(e)
      const oey = CY + R * Math.sin(e)
      const osx = CX + R * Math.cos(s)
      const osy = CY + R * Math.sin(s)

      const d = [
        `M${isx},${isy}`,
        `A${IR},${IR} 0 ${large} 1 ${iex},${iey}`,
        `L${oex},${oey}`,
        `A${R},${R} 0 ${large} 0 ${osx},${osy}`,
        "Z",
      ].join(" ")

      const pct = Math.round((seg.value / t) * 100)
      return { d, color: CHART_COLORS[i % CHART_COLORS.length], label: seg.label, pct }
    })
  })

  return (
    <div data-slot="chart-pie-area">
      <svg width={CX * 2} height={H} data-slot="chart-pie-svg">
        <For each={slices()}>
          {(slice) => <path d={slice.d} fill={slice.color} stroke="var(--surface-base)" stroke-width="2" />}
        </For>
        <text x={CX} y={CY - 6} data-slot="chart-pie-total">
          {formatTickValue(total())}
        </text>
        <text x={CX} y={CY + 10} data-slot="chart-pie-total-label">
          Total
        </text>
      </svg>
      <div data-slot="chart-pie-labels">
        <For each={slices()}>
          {(slice) => (
            <div data-slot="chart-pie-label-row">
              <span data-slot="chart-legend-swatch" style={{ background: slice.color }} />
              <span data-slot="chart-pie-label-text">{slice.label}</span>
              <span data-slot="chart-pie-label-pct">{slice.pct}%</span>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

// ── Entry point ──

export function DiagramRenderer(props: { document: DiagramDocument }) {
  return (
    <>
      <Show when={props.document.type === "graph"}>
        <DiagramGraph document={props.document as GraphDocument} />
      </Show>
      <Show when={props.document.type === "compare"}>
        <DiagramCompare document={props.document as CompareDocument} />
      </Show>
      <Show when={props.document.type === "sequence"}>
        <DiagramSequence document={props.document as SequenceDocument} />
      </Show>
      <Show when={props.document.type === "timeline"}>
        <DiagramTimeline document={props.document as TimelineDocument} />
      </Show>
      <Show when={props.document.type === "tree"}>
        <DiagramTree document={props.document as TreeDocument} />
      </Show>
      <Show when={props.document.type === "chart"}>
        <DiagramChart document={props.document as ChartDocument} />
      </Show>
    </>
  )
}
