import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon, type IconName } from "./icon"
import { Markdown } from "./markdown"
import "./dag-graph.css"

export interface DagNode {
  id: string
  content: string
  status: string
  deps: string[]
  assign?: string
  task_id?: string
  session_id?: string
  memo?: string
  result?: string
  worktree?: string
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

const CARD_W = 280
const MIN_CARD_H = 108
const MAX_CARD_H = 400
const GAP_X = 32
const GAP_Y = 56
const PAD_X = 48
const PAD_Y = 40

const HEADER_H = 26
const LINE_H = 20
const CARD_PAD_Y = 26
const CARD_GAP = 10
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
    case "blocked":
      return "BLOCKED"
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
    blocked: nodes.filter((n) => n.status === "blocked").length,
    pending: nodes.filter((n) => n.status === "pending").length,
  }
}
const NODE_INSPECTOR_HOVER_DELAY_MS = 2400

interface NodeBadge {
  kind: "worktree" | "session" | "result"
  icon: IconName
  label: string
  value: string
}

function nodeBadges(node: DagNode): NodeBadge[] {
  const badges: NodeBadge[] = []
  if (node.worktree) badges.push({ kind: "worktree", icon: "git-branch", label: "Worktree", value: node.worktree })
  if (node.result) badges.push({ kind: "result", icon: "clipboard-check", label: "Result", value: node.result })
  if (node.session_id) badges.push({ kind: "session", icon: "log-in", label: "Open session", value: node.session_id })
  return badges
}

function displayIdentifier(value: string): string {
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}…${value.slice(-4)}`
}

export function DagGraph(props: {
  nodes?: DagNode[]
  ready?: string[]
  variant?: "default" | "panel"
  selectedNodeId?: string
  onSelectNode?: (node: DagNode) => void
  focusNodeId?: string
  onViewportInteraction?: () => void
  onOpenSession?: (sessionID: string) => void
}) {
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [scale, setScale] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [dragging, setDragging] = createSignal(false)
  const [zooming, setZooming] = createSignal(false)
  const [hasUserMoved, setHasUserMoved] = createSignal(false)
  const [pointerMoved, setPointerMoved] = createSignal(false)

  const markerId = createUniqueId()
  let ref: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let dragStart: { pointer: { x: number; y: number }; pan: { x: number; y: number } } | undefined
  let clickNodeId: string | undefined
  const [hoveredNodeId, setHoveredNodeId] = createSignal<string | undefined>(undefined)
  const [inspectorNode, setInspectorNode] = createSignal<DagNode | undefined>(undefined)
  const [inspectorPosition, setInspectorPosition] = createSignal({ x: 0, y: 0 })
  let inspectorTimer: ReturnType<typeof setTimeout> | undefined

  const clearInspectorTimer = () => {
    clearTimeout(inspectorTimer)
    inspectorTimer = undefined
    setHoveredNodeId(undefined)
  }

  const closeNodeInspector = () => {
    clearInspectorTimer()
    setInspectorNode(undefined)
  }

  const inspectorIsPinned = () => inspectorNode() !== undefined

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0].contentRect.width))
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
    onCleanup(closeNodeInspector)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && inspectorNode()) closeNodeInspector()
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  const nodes = createMemo(() => props.nodes ?? [])
  const layout = createMemo(() => computeLayout(nodes(), containerWidth()))
  const readySet = createMemo(() => new Set(props.ready ?? []))
  const counts = createMemo(() => statusCounts(nodes()))

  // Track the set of node IDs separately so auto-focus only fires when nodes
  // are added or removed — not on every status change (which would cause the
  // viewport to jump wildly as each node flips pending→running→completed).
  const nodeIds = createMemo(() =>
    nodes()
      .map((n) => n.id)
      .join("\u0001"),
  )

  createEffect(
    on([nodeIds, () => containerWidth()], () => {
      const l = layout()
      if (!viewport || hasUserMoved() || l.width === 0 || l.height === 0) return
      focusActiveNodes()
    }),
  )

  createEffect(() => {
    const focusId = props.focusNodeId
    if (!focusId || hasUserMoved() || nodes().length > 200) return
    const laid = layout().laid
    if (laid.length === 0) return
    const target = laid.find((ln) => ln.node.id === focusId)
    if (!target || target.h === 0) return
    requestAnimationFrame(() => {
      fitToNodes([target])
    })
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

  let zoomTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(zoomTimer))

  function flagZooming() {
    setZooming(true)
    clearTimeout(zoomTimer)
    zoomTimer = setTimeout(() => setZooming(false), 220)
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
    flagZooming()
    setScale(next)
    setPan({ x: originX - worldX * next, y: originY - worldY * next })
    setHasUserMoved(true)
    props.onViewportInteraction?.()
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    zoomAt(scale() * factor, event.clientX, event.clientY)
  }

  function updateInspectorPosition(event: PointerEvent) {
    const inspectorWidth = 380
    const inspectorHeight = 440
    const maxX = window.innerWidth - inspectorWidth
    const maxY = window.innerHeight - inspectorHeight
    setInspectorPosition({
      x: Math.max(16, Math.min(event.clientX + 18, maxX)),
      y: Math.max(16, Math.min(event.clientY + 18, maxY)),
    })
  }

  function handleNodePointerEnter(node: DagNode, event: PointerEvent) {
    if (inspectorIsPinned()) return
    clearInspectorTimer()
    setHoveredNodeId(node.id)
    updateInspectorPosition(event)
    inspectorTimer = setTimeout(() => {
      setInspectorNode(node)
      setHoveredNodeId(undefined)
      inspectorTimer = undefined
    }, NODE_INSPECTOR_HOVER_DELAY_MS)
  }

  function handleNodePointerMove(event: PointerEvent) {
    if (hoveredNodeId() && !inspectorIsPinned()) updateInspectorPosition(event)
  }

  function handleNodePointerLeave() {
    clearInspectorTimer()
  }
  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | undefined
    if (target?.closest("button")) return
    clearInspectorTimer()
    setDragging(true)
    setHasUserMoved(true)
    props.onViewportInteraction?.()
    setPointerMoved(false)
    const card = target?.closest('[data-slot="dag-graph-card"]')
    clickNodeId = (card as HTMLElement | undefined)?.dataset.id ?? undefined
    dragStart = { pointer: { x: event.clientX, y: event.clientY }, pan: pan() }
    viewport?.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent) {
    if (!dragging() || !dragStart) return
    const dx = event.clientX - dragStart.pointer.x
    const dy = event.clientY - dragStart.pointer.y
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      setPointerMoved(true)
    }
    setPan({
      x: dragStart.pan.x + dx,
      y: dragStart.pan.y + dy,
    })
  }

  function handlePointerUp(event: PointerEvent) {
    if (!pointerMoved() && clickNodeId && props.onSelectNode) {
      const node = nodes().find((n) => n.id === clickNodeId)
      if (node) props.onSelectNode(node)
    }
    setDragging(false)
    dragStart = undefined
    clickNodeId = undefined
    viewport?.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      class="dag-graph"
      data-component="dag-graph"
      data-variant={props.variant === "panel" ? "panel" : undefined}
      ref={ref}
    >
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
            <Show when={counts().blocked > 0}>
              <span data-slot="dag-graph-stat" data-kind="blocked">
                {counts().blocked} blocked
              </span>
            </Show>
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
          data-zooming={zooming() ? "true" : undefined}
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
                  class="dag-node"
                  data-slot="dag-graph-card"
                  data-id={ln.node.id}
                  data-status={ln.node.status}
                  data-ready={readySet().has(ln.node.id)}
                  data-selected={props.selectedNodeId && props.selectedNodeId === ln.node.id ? "true" : undefined}
                  data-hovering={hoveredNodeId() === ln.node.id ? "true" : undefined}
                  tabIndex={0}
                  role="button"
                  aria-label={`DAG node: ${ln.node.content}`}
                  onPointerEnter={(event) => handleNodePointerEnter(ln.node, event)}
                  onPointerMove={handleNodePointerMove}
                  onPointerLeave={handleNodePointerLeave}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      props.onSelectNode?.(ln.node)
                    }
                  }}
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
                    <Show when={nodeBadges(ln.node).length > 0}>
                      <div data-slot="dag-graph-node-badges" aria-label="Node metadata">
                        <For each={nodeBadges(ln.node)}>
                          {(badge) =>
                            badge.kind === "session" && ln.node.session_id && props.onOpenSession ? (
                              <button
                                type="button"
                                data-slot="dag-graph-node-badge"
                                title={`${badge.label}: ${badge.value}`}
                                aria-label={`${badge.label}: ${badge.value}`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  props.onOpenSession?.(ln.node.session_id!)
                                }}
                              >
                                <Icon name={badge.icon} size="small" />
                              </button>
                            ) : (
                              <span data-slot="dag-graph-node-badge" title={`${badge.label}: ${badge.value}`}>
                                <Icon name={badge.icon} size="small" />
                              </span>
                            )
                          }
                        </For>
                      </div>
                    </Show>
                    <Show when={hoveredNodeId() === ln.node.id && inspectorNode()?.id !== ln.node.id}>
                      <span data-slot="dag-graph-hover-hold" aria-hidden="true" />
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
        <Portal>
          <Show when={inspectorNode()}>
            {(node) => (
              <div
                data-slot="dag-node-preview"
                style={{
                  left: `${inspectorPosition().x}px`,
                  top: `${inspectorPosition().y}px`,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <div data-slot="dag-node-preview-header">
                  <span data-slot="dag-node-preview-status" data-status={node().status}>
                    {statusLabel(node().status)}
                  </span>
                  <Show when={node().assign}>
                    {(assign) => <span data-slot="dag-node-preview-agent">@{assign()}</span>}
                  </Show>
                  {node().session_id && props.onOpenSession ? (
                    <button
                      type="button"
                      data-slot="dag-node-preview-open-session"
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onOpenSession?.(node().session_id!)
                      }}
                    >
                      <Icon name="log-in" size="small" />
                      Open session
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-slot="dag-node-preview-close"
                    aria-label="Close node details"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeNodeInspector()
                    }}
                  >
                    <Icon name="x" size="small" />
                  </button>
                </div>
                <div data-slot="dag-node-preview-title">{node().content}</div>
                <div data-slot="dag-node-preview-meta">
                  <Show when={node().task_id}>
                    {(taskID) => <span title={taskID()}>Task: {displayIdentifier(taskID())}</span>}
                  </Show>
                  <Show when={node().session_id}>
                    {(sessionID) => <span title={sessionID()}>Session: {displayIdentifier(sessionID())}</span>}
                  </Show>
                  <Show when={node().worktree}>{(worktree) => <span>Worktree: {worktree()}</span>}</Show>
                  <Show when={node().deps.length > 0}>
                    <span>Deps: {node().deps.join(", ")}</span>
                  </Show>
                </div>
                <Show when={node().memo}>{(memo) => <div data-slot="dag-node-preview-note">{memo()}</div>}</Show>
                <Show when={node().result}>
                  {(result) => (
                    <div data-slot="dag-node-preview-result">
                      <Markdown text={result()} cacheKey={`dag-node-result-${node().id}`} />
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </Portal>
        <div data-slot="dag-graph-hint">Drag to pan · Ctrl/⌘ + wheel to zoom · Double-click to focus</div>
      </Show>
    </div>
  )
}
