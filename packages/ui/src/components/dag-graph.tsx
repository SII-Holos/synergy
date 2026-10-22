import type { I18n } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js"
import { Popover } from "./popover"
import { Icon, type IconName } from "./icon"
import { Markdown } from "./markdown"
import "./dag-graph.css"
import { DAG_CHROME_DESC } from "./tool-title-descriptors"
import type { MessageDescriptor } from "@lingui/core"
import { getSemanticIcon } from "./semantic-icon"
import {
  MIN_CARD_H,
  computeLayout,
  focusTargets,
  type CardHeight,
  type DagNode,
  type LayoutNode,
} from "./dag-graph-layout"

export type { DagNode } from "./dag-graph-layout"

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function statusLabel(status: string, i18n?: I18n) {
  switch (status) {
    case "completed":
      return i18n?._({ id: "dag.status.completed", message: "DONE" }) ?? "DONE"
    case "running":
      return i18n?._({ id: "dag.status.running", message: "RUNNING" }) ?? "RUNNING"
    case "failed":
      return i18n?._({ id: "dag.status.failed", message: "FAILED" }) ?? "FAILED"
    case "blocked":
      return i18n?._({ id: "dag.status.blocked", message: "BLOCKED" }) ?? "BLOCKED"
    case "cancelled":
      return i18n?._({ id: "dag.status.cancelled", message: "SKIP" }) ?? "SKIP"
    default:
      return i18n?._({ id: "dag.status.pending", message: "PENDING" }) ?? "PENDING"
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

interface NodeBadge {
  kind: "worktree" | "session" | "result"
  icon: IconName
  label: string
  value: string
}

function nodeBadges(node: DagNode, _: (desc: MessageDescriptor) => string): NodeBadge[] {
  const badges: NodeBadge[] = []
  if (node.worktree)
    badges.push({ kind: "worktree", icon: "git-branch", label: _(DAG_CHROME_DESC.worktree), value: node.worktree })
  if (node.result)
    badges.push({ kind: "result", icon: "clipboard-check", label: _(DAG_CHROME_DESC.result), value: node.result })
  if (node.session_id)
    badges.push({ kind: "session", icon: "log-in", label: _(DAG_CHROME_DESC.openSession), value: node.session_id })
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
  showStats?: boolean
  enableInspector?: boolean
  getStatusLabel?: (node: DagNode) => string
  getNodeAriaLabel?: (node: DagNode) => string
  /* When true, the graph ignores container width changes and suppresses
     auto-focus. Use during parent animations (e.g. panel expand/collapse) so
     the ResizeObserver storm doesn't thrash layout + focus every frame. */
  frozen?: boolean
}) {
  const { _, i18n: linguiI18n } = useLingui()
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
  let dragCapture: HTMLElement | undefined
  const [inspectorID, setInspectorID] = createSignal<string>()
  const [inspectorAnchor, setInspectorAnchor] = createSignal<HTMLButtonElement>()
  const closeNodeInspector = () => setInspectorID(undefined)
  const activateNode = (node: DagNode, anchor: HTMLButtonElement) => {
    if (props.frozen) return
    props.onSelectNode?.(node)
    if (props.enableInspector === false) return
    setInspectorAnchor(anchor)
    setInspectorID(node.id)
  }

  onMount(() => {
    if (!ref) return
    setContainerWidth(ref.clientWidth)
    const observer = new ResizeObserver((entries) => {
      if (props.frozen) return
      setContainerWidth(entries[0].contentRect.width)
    })
    observer.observe(ref)
    onCleanup(() => observer.disconnect())
  })

  const nodes = createMemo(() => props.nodes ?? [])
  const inspectorNode = createMemo(() => nodes().find((node) => node.id === inspectorID()))
  createEffect(() => {
    if (props.frozen || props.enableInspector === false || !inspectorNode()) closeNodeInspector()
  })

  // Content wraps by glyph, not by character count: card text mixes CJK and
  // Latin, so a single per-character width under-measures every line and the
  // tail is clipped by the card's fixed height. Measure the rendered cards
  // instead. Measurements are keyed by card width because wrapping depends on
  // it, and offsetHeight is used because the stage is CSS-scaled.
  const [measured, setMeasured] = createSignal<{ cardW: number; heights: Map<string, number> }>({
    cardW: 0,
    heights: new Map(),
  })
  const measureCard: CardHeight = (node, cardW) => {
    const current = measured()
    return current.cardW === cardW ? current.heights.get(node.id) : undefined
  }
  const layout = createMemo(() => computeLayout(nodes(), containerWidth(), measureCard))

  let measureRaf: number | undefined
  onCleanup(() => {
    if (measureRaf !== undefined) cancelAnimationFrame(measureRaf)
  })
  createEffect(() => {
    const l = layout()
    if (!ref || containerWidth() === 0 || l.laid.length === 0) return
    if (measureRaf !== undefined) cancelAnimationFrame(measureRaf)
    measureRaf = requestAnimationFrame(() => {
      measureRaf = undefined
      const cards = [...(ref?.querySelectorAll<HTMLElement>('[data-slot="dag-graph-card"]') ?? [])]
      const previous = cards.map((card) => card.style.height)
      for (const card of cards) card.style.height = "auto"
      const natural = cards.map((card) => card.offsetHeight)
      cards.forEach((card, index) => (card.style.height = previous[index]))

      const heights = new Map<string, number>()
      let changed = false
      cards.forEach((card, index) => {
        const id = card.dataset.id
        // A card inside a display:none ancestor reports 0; keep the estimate
        // until it is laid out rather than collapsing it to the minimum.
        if (!id || natural[index] <= 0) return
        heights.set(id, Math.max(MIN_CARD_H, natural[index]))
        const current = l.laid.find((item) => item.node.id === id)?.h ?? 0
        if (Math.abs(current - Math.max(MIN_CARD_H, natural[index])) > 0.5) changed = true
      })
      if (heights.size === 0) return
      if (!changed && measured().cardW === l.cardW) return
      setMeasured({ cardW: l.cardW, heights })
    })
  })

  const layoutByID = createMemo(() => new Map(layout().laid.map((item) => [item.node.id, item])))
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

  // Auto-focus when node set or container width changes. Wrapped in
  // requestAnimationFrame so the forced reflow inside fitToNodes
  // (viewport.getBoundingClientRect()) doesn't run synchronously inside
  // Solid's effect batch — a sync reflow here blocked the main thread for
  // 55-60ms per call (verified via Chrome trace stackTrace on fitToNodes).
  let focusRaf: number | undefined
  onCleanup(() => {
    if (focusRaf !== undefined) cancelAnimationFrame(focusRaf)
  })
  createEffect(
    on([nodeIds, () => containerWidth()], () => {
      if (props.frozen) return
      const l = layout()
      if (!viewport || hasUserMoved() || l.width === 0 || l.height === 0) return
      if (focusRaf !== undefined) cancelAnimationFrame(focusRaf)
      focusRaf = requestAnimationFrame(() => {
        focusRaf = undefined
        focusActiveNodes()
      })
    }),
  )

  createEffect(() => {
    const focusId = props.focusNodeId
    if (props.frozen || !focusId || hasUserMoved() || nodes().length > 200) return
    const laid = layout().laid
    if (laid.length === 0) return
    const target = laid.find((ln) => ln.node.id === focusId)
    if (!target || target.h === 0) return
    requestAnimationFrame(() => {
      fitToNodes(focusTargets(laid, [target]))
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
    const seeds =
      running.length > 0 ? running : ready.length > 0 ? ready : pending.length > 0 ? pending.slice(0, 3) : laid
    fitToNodes(focusTargets(laid, seeds))
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

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | undefined
    if (props.frozen || target?.closest('button:not([data-slot="dag-graph-node-action"])')) return
    setDragging(true)
    setHasUserMoved(true)
    props.onViewportInteraction?.()
    setPointerMoved(false)
    dragStart = { pointer: { x: event.clientX, y: event.clientY }, pan: pan() }
    dragCapture = target?.closest<HTMLButtonElement>('[data-slot="dag-graph-node-action"]') ?? viewport
    dragCapture?.setPointerCapture(event.pointerId)
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
    setDragging(false)
    dragStart = undefined
    if (dragCapture?.hasPointerCapture(event.pointerId)) dragCapture.releasePointerCapture(event.pointerId)
    dragCapture = undefined
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
          <Show when={props.showStats !== false}>
            <div data-slot="dag-graph-stats">
              <span data-slot="dag-graph-stat" data-kind="done">
                {counts().completed} {_(DAG_CHROME_DESC.done)}
              </span>
              <span data-slot="dag-graph-stat" data-kind="running">
                {counts().running} {_(DAG_CHROME_DESC.running)}
              </span>
              <span data-slot="dag-graph-stat" data-kind="pending">
                {counts().pending} {_(DAG_CHROME_DESC.pending)}
              </span>
              <Show when={counts().blocked > 0}>
                <span data-slot="dag-graph-stat" data-kind="blocked">
                  {counts().blocked} {_(DAG_CHROME_DESC.blocked)}
                </span>
              </Show>
              <Show when={counts().failed > 0}>
                <span data-slot="dag-graph-stat" data-kind="failed">
                  {counts().failed} {_(DAG_CHROME_DESC.failed)}
                </span>
              </Show>
            </div>
          </Show>
          <div data-slot="dag-graph-controls">
            <button type="button" onClick={focusActiveNodes}>
              {_(DAG_CHROME_DESC.focus)}
            </button>
            <button type="button" onClick={fitView}>
              {_(DAG_CHROME_DESC.fit)}
            </button>
            <button type="button" aria-label={_(DAG_CHROME_DESC.zoomOut)} onClick={() => zoomAt(scale() * 0.86)}>
              −
            </button>
            <span>{Math.round(scale() * 100)}%</span>
            <button type="button" aria-label={_(DAG_CHROME_DESC.zoomIn)} onClick={() => zoomAt(scale() * 1.16)}>
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
          onPointerCancel={(event) => {
            setPointerMoved(true)
            handlePointerUp(event)
          }}
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
            <For each={layout().laid.map((item) => item.node.id)}>
              {(nodeID) => {
                const ln = () => layoutByID().get(nodeID)!
                return (
                  <div
                    class="dag-node"
                    data-slot="dag-graph-card"
                    data-id={ln().node.id}
                    data-status={ln().node.status}
                    data-ready={readySet().has(ln().node.id)}
                    data-selected={props.selectedNodeId && props.selectedNodeId === ln().node.id ? "true" : undefined}
                    style={{
                      left: `${ln().x}px`,
                      top: `${ln().y}px`,
                      width: `${layout().cardW}px`,
                      height: `${ln().h}px`,
                    }}
                  >
                    <button
                      type="button"
                      data-slot="dag-graph-node-action"
                      aria-label={
                        props.getNodeAriaLabel?.(ln().node) ??
                        _({
                          id: "dag.node.label",
                          message: "Task: {content}",
                          values: { content: ln().node.content },
                        })
                      }
                      aria-pressed={props.selectedNodeId === ln().node.id}
                      aria-haspopup={props.enableInspector !== false ? "dialog" : undefined}
                      aria-expanded={props.enableInspector !== false ? inspectorID() === ln().node.id : undefined}
                      onClick={(event) => {
                        if (event.detail && pointerMoved()) return
                        activateNode(ln().node, event.currentTarget)
                      }}
                    >
                      <span data-slot="dag-graph-card-header">
                        <span data-slot="dag-graph-status-dot" aria-hidden="true" />
                        <span data-slot="dag-graph-status-label">
                          {props.getStatusLabel?.(ln().node) ?? statusLabel(ln().node.status, linguiI18n())}
                        </span>
                      </span>
                      <span data-slot="dag-graph-card-content">{ln().node.content}</span>
                    </button>
                    <Show when={nodeBadges(ln().node, _).length > 0}>
                      <div data-slot="dag-graph-node-badges" aria-label={_(DAG_CHROME_DESC.nodeMetadata)}>
                        <For each={nodeBadges(ln().node, _)}>
                          {(badge) =>
                            badge.kind === "session" && ln().node.session_id && props.onOpenSession ? (
                              <button
                                type="button"
                                data-slot="dag-graph-node-badge"
                                title={`${badge.label}: ${badge.value}`}
                                aria-label={`${badge.label}: ${badge.value}`}
                                onClick={() => props.onOpenSession?.(ln().node.session_id!)}
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
                  </div>
                )
              }}
            </For>
          </div>
        </div>
        <Show when={props.enableInspector !== false}>
          <Popover
            open={!!inspectorNode()}
            onOpenChange={(open) => {
              if (!open) closeNodeInspector()
            }}
            anchorRef={inspectorAnchor}
            placement="right-start"
            class="dag-node-inspector"
            title={_(DAG_CHROME_DESC.nodeDetails)}
            translations={{ dismiss: _(DAG_CHROME_DESC.closeDetails) }}
            contentProps={{
              onCloseAutoFocus: (event: Event) => {
                event.preventDefault()
                const anchor = inspectorAnchor()
                if (!props.frozen && anchor?.isConnected && !anchor.closest("[inert]"))
                  anchor.focus({ preventScroll: true })
              },
            }}
          >
            <Show when={inspectorNode()}>
              {(current) => {
                const node = () => current()
                return (
                  <div data-slot="dag-node-preview">
                    <div data-slot="dag-node-preview-header">
                      <span data-slot="dag-node-preview-status" data-status={node().status}>
                        {props.getStatusLabel?.(node()) ?? statusLabel(node().status, linguiI18n())}
                      </span>
                      <Show keyed when={node().assign}>
                        {(assign) => <span data-slot="dag-node-preview-agent">@{assign}</span>}
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
                          <Icon name={getSemanticIcon("action.open")} size="small" />
                          {_(DAG_CHROME_DESC.openSession)}
                        </button>
                      ) : null}
                    </div>
                    <div data-slot="dag-node-preview-title">{node().content}</div>
                    <div data-slot="dag-node-preview-meta">
                      <Show keyed when={node().task_id}>
                        {(taskID) => (
                          <span title={taskID}>
                            {_(DAG_CHROME_DESC.task)}: {displayIdentifier(taskID)}
                          </span>
                        )}
                      </Show>
                      <Show keyed when={node().session_id}>
                        {(sessionID) => (
                          <span title={sessionID}>
                            {_(DAG_CHROME_DESC.session)}: {displayIdentifier(sessionID)}
                          </span>
                        )}
                      </Show>
                      <Show keyed when={node().worktree}>
                        {(worktree) => (
                          <span>
                            {_(DAG_CHROME_DESC.worktree)}: {worktree}
                          </span>
                        )}
                      </Show>
                      <Show when={node().deps.length > 0}>
                        <span>
                          {_(DAG_CHROME_DESC.deps)}: {node().deps.join(", ")}
                        </span>
                      </Show>
                    </div>
                    <Show keyed when={node().memo}>
                      {(memo) => <div data-slot="dag-node-preview-note">{memo}</div>}
                    </Show>
                    <Show keyed when={node().result}>
                      {(result) => (
                        <div data-slot="dag-node-preview-result">
                          <Markdown text={result} cacheKey={`dag-node-result-${node().id}`} />
                        </div>
                      )}
                    </Show>
                  </div>
                )
              }}
            </Show>
          </Popover>
        </Show>
        <div data-slot="dag-graph-hint">{_(DAG_CHROME_DESC.hint)}</div>
      </Show>
    </div>
  )
}
