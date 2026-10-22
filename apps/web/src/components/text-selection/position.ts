export type TextActionPoint = { x: number; y: number }
export type TextActionRect = TextActionPoint & { width: number; height: number }

const EDGE = 8
const GAP = 8

/**
 * Places the selection surface beside its selection: centered above when the
 * selection leaves room, otherwise below, then clamped inside the viewport.
 */
export function placeTextActionSurface(
  selection: TextActionRect,
  surface: { width: number; height: number },
  viewport: { width: number; height: number },
): TextActionPoint {
  const centered = selection.x + selection.width / 2 - surface.width / 2
  const x = Math.max(EDGE, Math.min(centered, viewport.width - surface.width - EDGE))
  const above = selection.y - surface.height - GAP
  if (above >= EDGE) return { x, y: above }
  const below = selection.y + selection.height + GAP
  return { x, y: Math.max(EDGE, Math.min(below, viewport.height - surface.height - EDGE)) }
}
