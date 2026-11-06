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

export interface LayoutNode {
  node: DagNode
  layer: number
  index: number
  x: number
  y: number
  h: number
}

export interface LayoutEdge {
  from: LayoutNode
  to: LayoutNode
}

const MAX_CARD_W = 280
export const MIN_CARD_H = 108

const GAP_X = 32
const GAP_Y = 56
const PAD_X = 48
const PAD_Y = 40

const HEADER_H = 26
const LINE_H = 20
// The card's own 12px vertical padding, doubled.
const CARD_PAD_Y = 24
const CARD_GAP = 10
// The card's own 14px horizontal padding, doubled.
const CARD_PAD_X = 28

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function contentWidth(cardW: number) {
  return Math.max(1, cardW - CARD_PAD_X)
}

function cardHeightFromParts(headerHeight: number, contentHeight: number): number {
  return Math.max(MIN_CARD_H, CARD_PAD_Y + headerHeight + CARD_GAP + contentHeight)
}

const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/
const WIDE_CHAR_W = 14
const NARROW_CHAR_W = 7.1

// Fallback for renderers without layout (SSR, tests): approximate advance widths.
// Live graphs measure the rendered content instead, because a single character
// width cannot represent text that mixes CJK and Latin glyphs.
function estimateCardH(content: string | undefined, cardW = MAX_CARD_W): number {
  const text = content ?? ""
  const available = contentWidth(cardW)
  let lines = 0
  let width = 0
  for (const char of text) {
    const advance = WIDE.test(char) ? WIDE_CHAR_W : NARROW_CHAR_W
    if (width > 0 && width + advance > available) {
      lines++
      width = 0
    }
    width += advance
  }
  return cardHeightFromParts(HEADER_H, Math.max(1, lines + 1) * LINE_H)
}

/**
 * Returns a measured card height, or undefined when the caller has no
 * measurement for the current card width yet. Wrapping depends on width, so a
 * measurement is only valid for the width it was taken at.
 */
export type CardHeight = (node: DagNode, cardW: number) => number | undefined

function originalIndex(nodes: DagNode[]) {
  return new Map(nodes.map((node, index) => [node.id, index]))
}

function averageDepOrder(node: DagNode, layerOrder: Map<string, number>, fallback: Map<string, number>) {
  const deps = node.deps ?? []
  if (deps.length === 0) return fallback.get(node.id) ?? 0
  const values = deps.map((dep) => layerOrder.get(dep) ?? fallback.get(dep) ?? fallback.get(node.id) ?? 0)
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function computeLayout(rawNodes: DagNode[], containerWidth: number, cardHeight?: CardHeight) {
  const nodes = rawNodes.filter((n) => n.id && n.status)
  if (nodes.length === 0)
    return { laid: [] as LayoutNode[], edges: [] as LayoutEdge[], width: 0, height: 0, cardW: MAX_CARD_W }

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
  const cardW = MAX_CARD_W
  const minWorldWidth = maxGroupSize * cardW + (maxGroupSize - 1) * GAP_X + PAD_X * 2
  const worldWidth = Math.max(containerWidth || 600, minWorldWidth)

  const heightOf = (node: DagNode) => {
    const measured = cardHeight?.(node, cardW)
    return measured && measured > 0 ? measured : estimateCardH(node.content, cardW)
  }

  const layerHeights: number[] = []
  for (let l = 0; l <= maxLayer; l++) {
    const group = sortedGroups.get(l) ?? []
    layerHeights.push(Math.max(...group.map((n) => heightOf(n)), MIN_CARD_H))
  }

  const laid: LayoutNode[] = []
  const byId = new Map<string, LayoutNode>()

  let cy = PAD_Y
  for (let l = 0; l <= maxLayer; l++) {
    const group = sortedGroups.get(l) ?? []
    const rowWidth = group.length * cardW + Math.max(0, group.length - 1) * GAP_X
    const offsetX = (worldWidth - rowWidth) / 2

    for (let i = 0; i < group.length; i++) {
      const ln: LayoutNode = {
        node: group[i],
        layer: l,
        index: i,
        x: offsetX + i * (cardW + GAP_X),
        y: cy,
        h: heightOf(group[i]),
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

  return { laid, edges, width: worldWidth, height, cardW }
}

/**
 * Frames the active cards together with the work they connect to. Framing a
 * single active card alone crops its siblings and children off the viewport
 * edge at 100% zoom, which reads as missing work rather than a panned viewport.
 */
export function focusTargets(laid: LayoutNode[], seeds: LayoutNode[], fallbackCount = 3): LayoutNode[] {
  const base = seeds.length > 0 ? seeds : laid.slice(0, fallbackCount)
  if (base.length === 0) return []
  const ids = new Set(base.map((node) => node.node.id))
  const layers = new Set(base.map((node) => node.layer))
  for (const node of laid) if (layers.has(node.layer)) ids.add(node.node.id)
  // Exactly one level down: enough to show what the active work leads into,
  // without pulling the whole subtree in and shrinking everything to fit.
  const parents = new Set(ids)
  for (const node of laid) if (node.node.deps?.some((dep) => parents.has(dep))) ids.add(node.node.id)
  return laid.filter((node) => ids.has(node.node.id))
}
